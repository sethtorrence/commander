import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext } from '@commander/domain';
import { createModelClient, createZaiProvider } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { type Meaning, setUpMeaning } from '.';
import type { DownloadProgress } from './download';
import type { Embedder } from './embedder';
import { FAKE_MODEL, fakeEmbedder } from './fake';

// Search by meaning in the Core (#73): the model downloaded once with progress and loaded, the
// Items and memories embedded in the background (and again as they change), and queries embedded
// for search, through the real Item store and model client. The stand-in embedder replaces the
// model and a controllable download replaces Hugging Face, so nothing is downloaded.

const user: ActionContext = { by: { kind: 'user' } };
const MODEL = { ...FAKE_MODEL, files: [{ path: 'model.onnx', size: 1000, sha256: 'x' }] };

let dir: string;
let store: ItemStore;
let meaning: Meaning;
let downloads: {
  progress: (progress: DownloadProgress) => void;
  finish: () => void;
  fail: (error: Error) => void;
}[];
let loads: number;

const openStore = () =>
  openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
  });

function start({
  downloaded = false,
  embedder = fakeEmbedder,
  retryMs = 60_000,
}: {
  downloaded?: boolean;
  embedder?: () => Embedder;
  retryMs?: number;
} = {}) {
  const client = createModelClient({
    settings: () => store.models.settings(),
    providers: { zai: createZaiProvider({ apiKey: async () => null }) },
    ledger: store.models,
    embedding: () => meaning.adapter(),
  });
  meaning = setUpMeaning({
    store,
    model: MODEL,
    downloaded: () => downloaded,
    download: ({ onProgress }) =>
      new Promise<void>((resolve, reject) => {
        downloads.push({
          progress: onProgress,
          finish: () => {
            downloaded = true;
            resolve();
          },
          fail: reject,
        });
      }),
    load: async () => {
      loads += 1;
      return embedder();
    },
    embed: (request) => client.embed(request),
    timing: { pauseMs: 0, pendingDelayMs: 0, retryMs, queryTimeoutMs: 1000, quietAfterQueryMs: 0 },
  });
  meaning.start();
}

async function until(check: () => boolean | Promise<boolean>, what = 'the condition') {
  for (let tries = 0; tries < 200; tries++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const addTodo = (title: string) =>
  store.record({ type: 'create', item: { kind: 'todo', title } }, user).itemId;
const titles = async (text: string) =>
  store.search
    .query({ text }, (await meaning.queryVector(text)) ?? undefined)
    .hits.map((hit) => hit.item.title);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-meaning-'));
  store = openStore();
  downloads = [];
  loads = 0;
});

afterEach(async () => {
  await meaning.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('getting the model', () => {
  it('downloads it once with progress, loads it, then embeds every Item and memory', async () => {
    addTodo('Throttle bursts on /sync');
    addTodo('Renew the passport');
    store.memory.learn({ kind: 'fact', text: 'Sam runs the pager rota', confirmed: true, sources: [] });
    start();
    await until(() => downloads.length === 1, 'the download');
    expect(meaning.status()).toMatchObject({ on: true, state: 'downloading', embedded: 0, total: 3 });

    downloads[0]?.progress({ receivedBytes: 400, totalBytes: 1000 });
    expect(meaning.status()).toMatchObject({ state: 'downloading', receivedBytes: 400, totalBytes: 1000 });
    // Until it is ready, search is by words alone.
    expect(await meaning.queryVector('the rate limiter thing')).toBeNull();
    expect(await titles('throttle')).toEqual(['Throttle bursts on /sync']);

    downloads[0]?.finish();
    await until(() => meaning.status().state === 'ready', 'ready');
    await until(() => meaning.status().embedded === 3, 'the backfill');
    expect(meaning.status()).toMatchObject({ state: 'ready', embedded: 3, total: 3, problem: null });
    expect(loads).toBe(1);
    expect(await titles('the rate limiter thing')).toEqual(['Throttle bursts on /sync']);
  });

  it('loads the model already downloaded, without downloading it again', async () => {
    start({ downloaded: true });
    await until(() => meaning.status().state === 'ready', 'ready');
    expect(downloads).toEqual([]);
  });

  it('shows why a download failed, tries again later, and at once when switched on again', async () => {
    start();
    await until(() => downloads.length === 1, 'the download');
    downloads[0]?.fail(new Error('Couldn’t reach huggingface.co'));
    await until(() => meaning.status().state === 'failed', 'the failure');
    expect(meaning.status().problem).toBe('Couldn’t reach huggingface.co');
    expect(await meaning.queryVector('the rate limiter thing')).toBeNull();

    meaning.setOn(true);
    await until(() => downloads.length === 2, 'the second download');
    downloads[1]?.finish();
    await until(() => meaning.status().state === 'ready', 'ready');
  });
});

describe('when the model stops working', () => {
  it('shows the problem, searches by words, and loads the model again later', async () => {
    addTodo('Throttle bursts on /sync');
    let broken = true;
    start({
      downloaded: true,
      retryMs: 20,
      embedder: () => {
        const working = fakeEmbedder();
        const wasBroken = broken;
        broken = false;
        return {
          embed: (texts) =>
            wasBroken ? Promise.reject(new Error('The embedding model stopped')) : working.embed(texts),
          close: working.close,
        };
      },
    });
    await until(() => meaning.status().embedded === 1, 'the model loaded again');
    expect(loads).toBe(2);
    expect(meaning.status()).toMatchObject({ state: 'ready', problem: null });
    expect(await titles('rate limiter')).toEqual(['Throttle bursts on /sync']);
  });
});

describe('keeping embeddings current', () => {
  it('embeds new and changed Items in the background as they are saved', async () => {
    start({ downloaded: true });
    await until(() => meaning.status().state === 'ready', 'ready');
    const id = addTodo('Renew the passport');
    await until(() => meaning.status().embedded === 1, 'the new Item');
    expect(await titles('travel')).toEqual(['Renew the passport']);

    store.record({ type: 'update', itemId: id, changes: { title: 'Sign the NDA' } }, user);
    await until(async () => (await titles('contract')).length === 1, 'the change');
    expect(await titles('contract')).toEqual(['Sign the NDA']);
  });

  it('logs every embedding on the Usage page: tokens and time, at no cost', async () => {
    addTodo('Throttle bursts on /sync');
    start({ downloaded: true });
    await until(() => meaning.status().embedded === 1, 'the backfill');
    await meaning.queryVector('rate limiter');
    const usage = store.models.usageSummary();
    expect(usage.byJob.map((job) => job.job).sort()).toEqual(['embed-index', 'embed-query']);
    expect(usage.byProvider).toMatchObject([{ provider: 'local', costUsd: 0 }]);
    expect(usage.thisMonth.inputTokens).toBeGreaterThan(0);
  });

  it('embeds no query too short to mean anything', async () => {
    start({ downloaded: true });
    await until(() => meaning.status().state === 'ready', 'ready');
    expect(await meaning.queryVector('ra')).toBeNull();
    expect(await meaning.queryVector('ENG-4')).toBeNull();
    expect(await meaning.queryVector('rate')).not.toBeNull();
  });
});

describe('switching it off', () => {
  it('stops embedding and searching by meaning, remembers that, and picks up again when on', async () => {
    start({ downloaded: true });
    await until(() => meaning.status().state === 'ready', 'ready');
    meaning.setOn(false);
    expect(meaning.status()).toMatchObject({ on: false, state: 'off' });
    addTodo('Throttle bursts on /sync');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(meaning.status().embedded).toBe(0);
    expect(await meaning.queryVector('rate limiter')).toBeNull();

    // Off stays off across a restart.
    await meaning.stop();
    start({ downloaded: true });
    expect(meaning.status().state).toBe('off');

    meaning.setOn(true);
    await until(() => meaning.status().embedded === 1, 'the backfill');
    expect(await titles('rate limiter')).toEqual(['Throttle bursts on /sync']);
  });
});
