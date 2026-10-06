import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { LinearIssueDetail } from '@commander/domain';
import { createModelClient, createZaiProvider } from '@commander/models';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { modelDownloaded } from './download';
import { workerEmbedder } from './embedder';
import { type Meaning, setUpMeaning } from './index';
import { GRANITE_97M } from './model';

/*
  The real embedding model (#73), opt-in: it needs the model's files, which no automated run
  downloads. Point COMMANDER_EMBEDDING_MODEL_DIR at a folder holding them (the one Commander downloads
  into: <userData>/models/granite-embedding-97m-multilingual-r2) and run
  `COMMANDER_EMBEDDING_MODEL_DIR=… pnpm test:perf apps/core/src/meaning`. Skipped otherwise.

  - A query sharing no words with its target finds it: "rate limiter" → "Throttle bursts on /sync".
  - The backfill of 1,300 Items (about what Commander holds after a few weeks with Gmail, Outlook,
    GitHub, Linear, Teams and calendars), with text as long as real Items' (most short, some emails
    and chats long), timed, with the Core's main thread watched for stalls while it runs.
*/

const dir = process.env.COMMANDER_EMBEDDING_MODEL_DIR;
const WORKER = join(import.meta.dirname, 'embed-worker.ts');
const ITEMS = 1300;

const WORDS = (
  'the a we to of and for on in with is it that this our customer release deploy staging review ' +
  'invoice contract meeting agenda notes follow up next week Friday Monday client budget timeline ' +
  'design draft feedback approve merge branch test flaky timeout crash dashboard report quarterly ' +
  'onboarding hiring offer candidate interview schedule travel flight hotel lunch dinner thanks ' +
  'please could you let me know update status blocked waiting priority urgent ticket support bug'
).split(' ');
let seed = 11;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};
const words = (n: number) =>
  Array.from({ length: n }, () => WORDS[Math.floor(random() * WORDS.length)] as string).join(' ');
// Words of text an Item carries, as Commander's sources give them: most short (Todos, Blocks,
// events, issues), some long (emails, chats, pull requests), cut to 2,000 characters when embedded.
const lengthOfText = () => {
  const roll = random();
  if (roll < 0.35) return 8 + Math.floor(random() * 20);
  if (roll < 0.7) return 40 + Math.floor(random() * 120);
  return 200 + Math.floor(random() * 400);
};

function issue(identifier: string, title: string, description: string) {
  const detail: LinearIssueDetail = {
    kind: 'linear-issue',
    identifier,
    url: `https://linear.app/acme/issue/${identifier}`,
    team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
    state: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#999999' },
    priority: 0,
    assignee: null,
    creator: null,
    labels: [],
    cycle: null,
    linearProject: null,
    dueDate: null,
    estimate: null,
    description,
    comments: [],
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
  };
  return { externalId: identifier, kind: 'linear-issue' as const, title, detail };
}

let folder: string;
let store: ItemStore;
let meaning: Meaning;

async function until(check: () => boolean, timeoutMs: number) {
  const began = Date.now();
  while (!check()) {
    if (Date.now() - began > timeoutMs) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!dir)('the real embedding model (opt-in)', () => {
  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'commander-real-model-'));
    store = openItemStore({
      path: join(folder, 'commander.db'),
      snapshotDir: join(folder, 'snapshots'),
      migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    });
    const client = createModelClient({
      settings: () => store.models.settings(),
      providers: { zai: createZaiProvider({ apiKey: async () => null }) },
      ledger: store.models,
      embedding: () => meaning.adapter(),
    });
    meaning = setUpMeaning({
      store,
      model: GRANITE_97M,
      downloaded: () => modelDownloaded(dir as string, GRANITE_97M.files),
      download: async () => {
        throw new Error('The model’s files aren’t all in COMMANDER_EMBEDDING_MODEL_DIR');
      },
      load: () => workerEmbedder(WORKER, dir as string, GRANITE_97M),
      embed: (request) => client.embed(request),
      timing: { pendingDelayMs: 0 },
    });
  });

  afterAll(async () => {
    await meaning?.stop();
    store?.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it('finds “Throttle bursts on /sync” for “rate limiter”, which shares no words with it', async () => {
    store.saveFromSource({
      source: 'linear',
      account: 'linear:org-acme',
      items: [
        issue('ENG-1', 'Throttle bursts on /sync', 'Clients hammer the endpoint after reconnecting.'),
        issue('ENG-2', 'Renew the passport before March', ''),
        issue('ENG-3', 'Acme contract redlines from legal', 'Their counsel sent the marked-up MSA.'),
        issue('ENG-4', 'Fix the login loop on Safari', 'SSO bounces back to the sign-in page.'),
        issue('ENG-5', 'Quarterly board deck', 'Numbers for Q3 and the hiring plan.'),
        issue('ENG-6', 'Lunch with Priya on Friday', ''),
        issue('ENG-7', 'Move the staging database to the new cluster', ''),
        issue('ENG-8', 'Webhook retries pile up in the queue', 'Dead letters after five attempts.'),
      ],
    });
    const loading = performance.now();
    meaning.start();
    await until(() => meaning.status().state === 'ready', 60_000);
    console.info(`Loaded ${GRANITE_97M.name} in ${Math.round(performance.now() - loading)} ms`);
    await until(() => meaning.status().embedded === 8, 60_000);

    const vector = await meaning.queryVector('rate limiter');
    expect(vector).not.toBeNull();
    const hits = store.search.query({ text: 'rate limiter' }, vector ?? undefined).hits;
    console.info(
      'rate limiter →',
      hits.map((hit) => hit.item.title),
    );
    expect(hits[0]?.item.title).toBe('Throttle bursts on /sync');
    expect(hits[0]?.foundBy).toEqual(['meaning']);
    // And what the issue's example asks for.
    const acme = await meaning.queryVector('the Acme contract thing');
    expect(
      store.search.query({ text: 'the Acme contract thing' }, acme ?? undefined).hits[0]?.item.title,
    ).toBe('Acme contract redlines from legal');
  }, 120_000);

  it(
    `embeds ${ITEMS} Items in the background without stalling the Core’s main thread`,
    async () => {
      const before = meaning.status().embedded;
      store.saveFromSource({
        source: 'linear',
        account: 'linear:org-acme',
        items: Array.from({ length: ITEMS }, (_, n) => issue(`OPS-${n}`, words(6), words(lengthOfText()))),
      });
      const stalls = monitorEventLoopDelay({ resolution: 10 });
      stalls.enable();
      const began = performance.now();
      meaning.catchUp();
      await until(() => meaning.status().embedded === before + ITEMS, 30 * 60_000);
      const took = performance.now() - began;
      stalls.disable();

      const queries: number[] = [];
      for (const text of [
        'who is waiting on the invoice',
        'flaky tests on staging',
        'travel for the offsite',
      ]) {
        const queried = performance.now();
        await meaning.queryVector(text);
        queries.push(performance.now() - queried);
      }
      const usage = store.models.usageSummary();
      console.info(
        `Backfilled ${ITEMS} Items in ${(took / 1000).toFixed(1)} s (${((ITEMS / took) * 1000).toFixed(1)} a second); ` +
          `main thread delay p50 ${(stalls.percentile(50) / 1e6).toFixed(1)} ms, p99 ${(stalls.percentile(99) / 1e6).toFixed(1)} ms, ` +
          `max ${(stalls.max / 1e6).toFixed(1)} ms; queries ${queries.map((ms) => `${Math.round(ms)} ms`).join(', ')}; ` +
          `${usage.thisMonth.inputTokens} tokens over ${usage.thisMonth.calls} calls; rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`,
      );
      expect(stalls.percentile(99) / 1e6).toBeLessThan(100);
    },
    30 * 60_000,
  );
});
