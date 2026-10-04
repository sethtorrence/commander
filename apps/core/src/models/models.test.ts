import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CoreAccessTokenReply,
  type CoreAccessTokenRequest,
  type CoreModelsReply,
  coreModelsReply,
  defaultModelSettings,
  type ModelsRequest,
} from '@commander/domain';
import { chatCompletion, type FakeOpenAIServer, startFakeOpenAIServer } from '@commander/models/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccessTokens } from '../access-tokens';
import { type ItemStore, openItemStore } from '../item-store';
import { createKnownSecrets } from '../safety/known-secrets';
import { setUpModels } from '.';

const KEY = 'zai-key-4f9a1c0e7b2d';

let dir: string;
let store: ItemStore;
let server: FakeOpenAIServer;
let savedKey: string | null;
let tokenRequests: CoreAccessTokenRequest[];
let models: ReturnType<typeof setUpModels>;
let secrets: ReturnType<typeof createKnownSecrets>;
const replies: CoreModelsReply[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'commander-core-models-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
  });
  server = await startFakeOpenAIServer();
  savedKey = KEY;
  tokenRequests = [];
  replies.length = 0;
  // Plays the main process: answers the Core's access token requests from "the keyring".
  secrets = createKnownSecrets();
  const accessTokens = createAccessTokens(
    (request) => {
      tokenRequests.push(request);
      const response: CoreAccessTokenReply['response'] = savedKey
        ? { ok: true, token: savedKey, kind: 'api-key' }
        : { ok: false, reason: 'unknown-account', error: 'No Z.ai API key is saved.' };
      queueMicrotask(() => accessTokens.settle({ type: 'access-token-reply', id: request.id, response }));
    },
    { secrets },
  );
  models = setUpModels(store, {
    send: (message) => replies.push(coreModelsReply.parse(message)),
    accessTokens,
    secrets,
  });
});

afterEach(async () => {
  store.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

let nextId = 1;
async function ask(request: ModelsRequest): Promise<CoreModelsReply['response']> {
  const id = nextId++;
  expect(models.handle({ type: 'models-request', id, request })).toBe(true);
  await expect.poll(() => replies.find((reply) => reply.id === id), { timeout: 5_000 }).toBeDefined();
  const reply = replies.find((reply) => reply.id === id);
  if (!reply) throw new Error('No reply');
  return reply.response;
}

async function pointAtFakeServer() {
  const tiers = defaultModelSettings.tiers;
  await ask({
    op: 'save-settings',
    settings: {
      ...defaultModelSettings,
      tiers: {
        quick: { ...tiers.quick, baseUrl: server.baseUrl },
        deep: { ...tiers.deep, baseUrl: server.baseUrl },
      },
    },
  });
}

describe('the model key and the messages', () => {
  it('borrows the key first and refuses messages that carry it, even before it was ever borrowed', async () => {
    await pointAtFakeServer();
    server.reply({ json: chatCompletion('ok', { prompt: 1, completion: 1 }) });

    await expect(
      models.client.complete({
        tier: 'quick',
        job: 'suggest-todos',
        messages: [{ role: 'user', content: `my key is ${KEY}, keep it safe` }],
      }),
    ).rejects.toThrow(/nothing was sent/);
    expect(server.requests).toHaveLength(0);
    expect(tokenRequests).toHaveLength(1);
  });
});

describe('Settings → Ares, answered by the Core', () => {
  it('reads the defaults, then saves and reads back the tiers', async () => {
    expect(await ask({ op: 'settings' })).toEqual({ ok: true, result: defaultModelSettings });

    const deep = { ...defaultModelSettings.tiers.deep, reasoningEffort: 'max' as const };
    const settings = { ...defaultModelSettings, tiers: { ...defaultModelSettings.tiers, deep } };
    expect(await ask({ op: 'save-settings', settings })).toEqual({ ok: true, result: settings });
    expect(await ask({ op: 'settings' })).toEqual({ ok: true, result: settings });
  });

  it('refuses settings outside the contract', async () => {
    const response = await ask({
      op: 'save-settings',
      settings: { ...defaultModelSettings, monthlyCapUsd: -5 },
    });

    expect(response).toMatchObject({ ok: false });
  });

  it('runs Test as a one-line Quick call with the key from the main process, and counts it', async () => {
    await pointAtFakeServer();
    server.reply({ json: chatCompletion('I hear you, Seth.', { prompt: 2_000, completion: 400 }) });

    const response = await ask({ op: 'test' });

    expect(tokenRequests).toMatchObject([{ type: 'access-token-request', account: 'model-key:zai' }]);
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(server.requests[0]?.body).toMatchObject({ model: 'glm-5.3-flash', reasoning_effort: 'low' });
    // 2,000 input at $0.15 and 400 output at $0.50 per 1M tokens.
    expect(response).toEqual({
      ok: true,
      result: {
        reply: 'I hear you, Seth.',
        provider: 'zai',
        model: 'glm-5.3-flash',
        latencyMs: expect.any(Number),
        costUsd: expect.closeTo(0.0005, 10),
      },
    });
    const usage = await ask({ op: 'usage' });
    expect(usage).toMatchObject({
      ok: true,
      result: {
        today: { calls: 1, inputTokens: 2_000, outputTokens: 400 },
        byJob: [{ job: 'settings-test' }],
      },
    });
  });

  it('never writes the key or the prompt into the database', async () => {
    await pointAtFakeServer();
    await ask({ op: 'test' });
    store.close();
    store = openItemStore({
      path: join(dir, 'commander.db'),
      snapshotDir: join(dir, 'snapshots'),
      migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    });

    const files = readdirSync(dir).filter((name) => name.startsWith('commander.db'));
    for (const file of files) {
      const bytes = readFileSync(join(dir, file)).toString('latin1');
      expect(bytes).not.toContain(KEY);
      expect(bytes).not.toContain('Hello from the fake server.');
    }
  });

  it('says what to do when no key is saved', async () => {
    await pointAtFakeServer();
    savedKey = null;

    const response = await ask({ op: 'test' });

    expect(response).toEqual({
      ok: false,
      kind: 'no-key',
      error: expect.stringContaining('Settings → Ares'),
    });
    expect(server.requests).toHaveLength(0);
  });

  it('passes on a refused key as a typed failure', async () => {
    await pointAtFakeServer();
    server.reply({ status: 401, json: { error: { code: '1000', message: 'Authentication failed' } } });

    expect(await ask({ op: 'test' })).toMatchObject({ ok: false, kind: 'auth' });
  });

  it('ignores messages that are not for it', () => {
    expect(models.handle({ type: 'item-store-request', id: 1, request: { op: 'query' } })).toBe(false);
  });
});
