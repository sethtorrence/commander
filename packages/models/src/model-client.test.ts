import { defaultModelSettings, type ModelSettings } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createMemoryLedger,
  createModelClient,
  createZaiProvider,
  type EmbeddingProviderAdapter,
  isOverCap,
  type MemoryLedger,
  ModelError,
} from '.';
import {
  chatCompletion,
  type FakeOpenAIServer,
  startFakeOpenAIServer,
  streamedCompletion,
} from './testing/fake-openai-server';

let server: FakeOpenAIServer;
let settings: ModelSettings;
let ledger: MemoryLedger;
let clock: number;
const waits: number[] = [];

beforeEach(async () => {
  server = await startFakeOpenAIServer();
  const tier = { baseUrl: server.baseUrl };
  settings = {
    ...defaultModelSettings,
    tiers: {
      quick: { ...defaultModelSettings.tiers.quick, ...tier },
      deep: { ...defaultModelSettings.tiers.deep, ...tier },
    },
  };
  ledger = createMemoryLedger();
  clock = new Date(2026, 9, 15, 9, 30).getTime();
  waits.length = 0;
});

afterEach(async () => {
  await server.close();
});

function client({ apiKey = 'zai-test-key' as string | null, timeoutMs = 5_000 } = {}) {
  return createModelClient({
    settings: () => settings,
    providers: {
      zai: createZaiProvider({
        apiKey: async () => apiKey,
        timeoutMs,
        random: () => 1,
        sleep: async (ms) => {
          waits.push(ms);
        },
      }),
    },
    ledger,
    now: () => clock,
  });
}

const hello = [{ role: 'user' as const, content: 'Say hello.' }];

describe('a Quick call', () => {
  it('posts an OpenAI-compatible chat completion and returns the reply with its usage and cost', async () => {
    server.reply({
      json: chatCompletion('Hello, Seth.', { prompt: 1_000_000, cached: 200_000, completion: 100_000 }),
    });

    const result = await client().complete({ tier: 'quick', job: 'sort-email', messages: hello });

    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(request).toMatchObject({ method: 'POST', path: '/v4/chat/completions' });
    expect(request?.headers.authorization).toBe('Bearer zai-test-key');
    expect(request?.body).toEqual({
      model: 'glm-5.3-flash',
      messages: hello,
      reasoning_effort: 'low',
      stream: false,
    });
    expect(result.text).toBe('Hello, Seth.');
    // 800k uncached input at $0.15, 200k cached at $0.03, 100k output at $0.50 (per 1M tokens).
    expect(result.usage).toMatchObject({
      inputTokens: 1_000_000,
      cachedTokens: 200_000,
      outputTokens: 100_000,
    });
    expect(result.usage.costUsd).toBeCloseTo(0.12 + 0.006 + 0.05, 10);
    expect(result.usage.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result).toMatchObject({ provider: 'zai', model: 'glm-5.3-flash', tier: 'quick' });
  });
});

describe('thinking levels', () => {
  const effortSent = () => server.requests.at(-1)?.body.reasoning_effort;

  it('default to low on the Quick tier and high on the Deep tier', async () => {
    await client().complete({ tier: 'quick', job: 'sort-email', messages: hello });
    expect(effortSent()).toBe('low');
    await client().complete({ tier: 'deep', job: 'meeting-prep', messages: hello });
    expect(effortSent()).toBe('high');
  });

  it('follow the tier settings as they change', async () => {
    settings.tiers.deep = { ...settings.tiers.deep, reasoningEffort: 'max', model: 'glm-5.3' };
    await client().complete({ tier: 'deep', job: 'meeting-prep', messages: hello });
    expect(server.requests.at(-1)?.body).toMatchObject({ model: 'glm-5.3', reasoning_effort: 'max' });
  });

  it('can be set for one call', async () => {
    await client().complete({ tier: 'quick', job: 'sort-email', messages: hello, reasoningEffort: 'high' });
    expect(effortSent()).toBe('high');
  });

  it('take a per-job override from settings over the tier and the call', async () => {
    settings.jobOverrides = { 'draft-reply': { reasoningEffort: 'max' } };

    await client().complete({ tier: 'deep', job: 'draft-reply', messages: hello, reasoningEffort: 'low' });
    expect(effortSent()).toBe('max');
    await client().complete({ tier: 'deep', job: 'meeting-prep', messages: hello });
    expect(effortSent()).toBe('high');
  });
});

describe('JSON replies', () => {
  const bucketChoice = z.object({ bucket: z.enum(['FYI', 'Needs reply']), confidence: z.number() });
  const sortThis = [{ role: 'user' as const, content: 'Which Bucket? Reply in JSON.' }];

  it('ask for a JSON object and come back validated against the schema', async () => {
    server.reply({ json: chatCompletion('{"bucket":"FYI","confidence":0.98}') });

    const result = await client().complete({
      tier: 'quick',
      job: 'sort-email',
      messages: sortThis,
      schema: bucketChoice,
    });

    expect(server.requests[0]?.body.response_format).toEqual({ type: 'json_object' });
    expect(result.json).toEqual({ bucket: 'FYI', confidence: 0.98 });
  });

  it('retry once with the validation error when the reply does not fit, and log both calls', async () => {
    server.reply(
      { json: chatCompletion('{"bucket":"Junk mail","confidence":0.4}') },
      { json: chatCompletion('{"bucket":"FYI","confidence":0.9}') },
    );

    const result = await client().complete({
      tier: 'quick',
      job: 'sort-email',
      messages: sortThis,
      schema: bucketChoice,
    });

    expect(result.json).toEqual({ bucket: 'FYI', confidence: 0.9 });
    expect(server.requests).toHaveLength(2);
    const retry = server.requests[1]?.body.messages as { role: string; content: string }[];
    expect(retry.slice(0, 2)).toEqual([
      sortThis[0],
      { role: 'assistant', content: '{"bucket":"Junk mail","confidence":0.4}' },
    ]);
    expect(retry[2]).toMatchObject({ role: 'user', content: expect.stringContaining('bucket') });
    expect(ledger.calls.map((call) => call.outcome)).toEqual(['ok', 'ok']);
    expect(result.usage.inputTokens).toBe(40);
  });

  it('fail with a typed error when the retry does not fit either', async () => {
    server.reply({ json: chatCompletion('not json at all') }, { json: chatCompletion('{"bucket":"Spam"}') });

    const failure = client().complete({
      tier: 'quick',
      job: 'sort-email',
      messages: sortThis,
      schema: bucketChoice,
    });

    await expect(failure).rejects.toBeInstanceOf(ModelError);
    await expect(failure).rejects.toMatchObject({ kind: 'invalid-reply' });
    expect(server.requests).toHaveLength(2);
  });

  it('can be asked for without a schema', async () => {
    server.reply({ json: chatCompletion('```json\n{"anything": [1, 2]}\n```') });

    const result = await client().complete({
      tier: 'quick',
      job: 'sort-email',
      messages: sortThis,
      json: true,
    });

    expect(server.requests[0]?.body.response_format).toEqual({ type: 'json_object' });
    expect(result.json).toEqual({ anything: [1, 2] });
  });
});

describe('streaming', () => {
  it('hands over tokens as they arrive, then the whole reply with its usage', async () => {
    server.reply({ sse: streamedCompletion(['Morning', ', ', 'Seth.'], { prompt: 30, completion: 12 }) });

    const stream = client().complete({ tier: 'deep', job: 'conversation', messages: hello, stream: true });
    const tokens: string[] = [];
    for await (const token of stream) tokens.push(token);
    const result = await stream.done;

    expect(server.requests[0]?.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: 'high',
    });
    expect(tokens).toEqual(['Morning', ', ', 'Seth.']);
    expect(result.text).toBe('Morning, Seth.');
    expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 12 });
    expect(ledger.calls).toMatchObject([
      { job: 'conversation', tier: 'deep', inputTokens: 30, outputTokens: 12 },
    ]);
  });

  it('ends the token stream with the error when the call fails', async () => {
    server.reply({ status: 401, json: { error: { code: '1000', message: 'Authentication failed' } } });

    const stream = client().complete({ tier: 'deep', job: 'conversation', messages: hello, stream: true });
    const drain = async () => {
      for await (const _token of stream) {
        // Nothing arrives.
      }
    };

    await expect(drain()).rejects.toMatchObject({ kind: 'auth' });
    await expect(stream.done).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('when the provider pushes back', () => {
  const rateLimited = (headers: Record<string, string> = {}) => ({
    status: 429,
    headers,
    json: { error: { code: '1302', message: 'Rate limit reached for requests' } },
  });
  const quick = () => client().complete({ tier: 'quick', job: 'sort-email', messages: hello });

  it('waits as long as Retry-After asks on a 429, then tries again', async () => {
    server.reply(rateLimited({ 'retry-after': '2' }), { json: chatCompletion('Got there.') });

    const result = await quick();

    expect(result.text).toBe('Got there.');
    expect(waits).toEqual([2_000]);
    expect(server.requests).toHaveLength(2);
    expect(ledger.calls).toMatchObject([{ outcome: 'ok' }]);
  });

  it('backs off longer each time on 429s without Retry-After and on 5xx errors', async () => {
    server.reply(
      rateLimited(),
      { status: 503, json: {} },
      { status: 500, json: {} },
      { json: chatCompletion('Up.') },
    );

    await expect(quick()).resolves.toMatchObject({ text: 'Up.' });
    expect(waits).toEqual([1_000, 2_000, 4_000]);
  });

  it('gives up with a typed error once the retries run out, and logs the failed call', async () => {
    server.reply(
      { status: 502, json: {} },
      { status: 502, json: {} },
      { status: 502, json: {} },
      { status: 502, json: {} },
    );

    await expect(quick()).rejects.toMatchObject({ kind: 'unavailable', details: { status: 502 } });
    expect(server.requests).toHaveLength(4);
    expect(ledger.calls).toMatchObject([
      { outcome: 'unavailable', inputTokens: 0, outputTokens: 0, costUsd: 0 },
    ]);
  });

  it('does not wait longer than a minute: a longer Retry-After fails at once as rate limited', async () => {
    server.reply(rateLimited({ 'retry-after': '600' }));

    await expect(quick()).rejects.toMatchObject({ kind: 'rate-limit', details: { retryAfterMs: 600_000 } });
    expect(waits).toEqual([]);
  });

  it('reports a refused key without retrying', async () => {
    server.reply({ status: 401, json: { error: { code: '1000', message: 'Authentication failed' } } });

    await expect(quick()).rejects.toMatchObject({ kind: 'auth', details: { status: 401 } });
    expect(server.requests).toHaveLength(1);
    expect(ledger.calls).toMatchObject([{ outcome: 'auth' }]);
  });

  it('reports an account out of credit without retrying, though Z.ai sends it as a 429', async () => {
    server.reply({ status: 429, json: { error: { code: '1113', message: 'Insufficient balance' } } });

    await expect(quick()).rejects.toMatchObject({ kind: 'billing' });
    expect(server.requests).toHaveLength(1);
  });

  it('times out a request that never answers', async () => {
    server.reply({ hang: true });

    const failure = client({ timeoutMs: 50 }).complete({ tier: 'quick', job: 'sort-email', messages: hello });

    await expect(failure).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('does not call out at all without an API key', async () => {
    await expect(
      client({ apiKey: null }).complete({ tier: 'quick', job: 'sort-email', messages: hello }),
    ).rejects.toMatchObject({ kind: 'no-key' });
    expect(server.requests).toHaveLength(0);
    expect(ledger.calls).toEqual([]);
  });

  it('reports a key that cannot be read (no keyring) the same way, without calling out', async () => {
    const noKeyring = createModelClient({
      settings: () => settings,
      providers: {
        zai: createZaiProvider({
          apiKey: () => Promise.reject(new Error('no system keyring was found')),
        }),
      },
      ledger,
    });

    await expect(
      noKeyring.complete({ tier: 'quick', job: 'sort-email', messages: hello }),
    ).rejects.toMatchObject({
      kind: 'no-key',
      message: expect.stringContaining('no system keyring'),
    });
    expect(server.requests).toHaveLength(0);
    expect(ledger.calls).toEqual([]);
  });
});

describe('the monthly cap', () => {
  // A million output tokens at $0.50 per 1M.
  const halfDollar = { json: chatCompletion('Done.', { prompt: 0, completion: 1_000_000 }) };
  const spent = (costUsd: number, at = clock) =>
    ledger.record({
      at,
      job: 'earlier',
      tier: 'quick',
      provider: 'zai',
      model: 'glm-5.3-flash',
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      costUsd,
      outcome: 'ok',
    });
  const call = (tier: 'quick' | 'deep') => client().complete({ tier, job: 'summary', messages: hello });

  beforeEach(() => {
    settings.monthlyCapUsd = 1;
  });

  it('records one warning a month once spend reaches 80%', async () => {
    spent(0.4);
    server.reply(halfDollar, halfDollar);

    await call('quick');
    clock += 60_000;
    await call('quick');

    expect(ledger.capWarnings).toEqual([
      { month: '2026-10', at: expect.any(Number), spentUsd: expect.closeTo(0.9, 10), capUsd: 1 },
    ]);
  });

  it('starts counting again each calendar month', async () => {
    spent(0.95, new Date(2026, 8, 30, 23, 0).getTime());

    await call('deep');

    expect(server.requests).toHaveLength(1);
    expect(ledger.capWarnings).toEqual([]);
  });

  it('stops Deep calls with an over-cap error once reached, without calling out', async () => {
    spent(1);

    const failure = call('deep');

    await expect(failure).rejects.toMatchObject({ kind: 'over-cap' });
    await expect(failure).rejects.toSatisfy(isOverCap);
    expect(server.requests).toHaveLength(0);
  });

  it('lets Quick calls carry on past the cap', async () => {
    spent(1.2);

    await expect(call('quick')).resolves.toMatchObject({ text: 'Hello from the fake server.' });
  });

  it('sends Deep calls to the fallback model when one is set', async () => {
    settings.deepFallback = { ...settings.tiers.deep, model: 'glm-4.5-air', reasoningEffort: 'low' };
    spent(1);

    const result = await call('deep');

    expect(server.requests[0]?.body).toMatchObject({ model: 'glm-4.5-air', reasoning_effort: 'low' });
    expect(result).toMatchObject({ tier: 'deep', model: 'glm-4.5-air' });
    expect(ledger.calls.at(-1)).toMatchObject({ tier: 'deep', model: 'glm-4.5-air', costUsd: null });
  });

  it('does nothing without a cap', async () => {
    settings.monthlyCapUsd = null;
    spent(500);

    await expect(call('deep')).resolves.toMatchObject({ text: 'Hello from the fake server.' });
    expect(ledger.capWarnings).toEqual([]);
  });
});

describe('embeddings', () => {
  const embeddingClient = (embedder: EmbeddingProviderAdapter | null) =>
    createModelClient({
      settings: () => settings,
      providers: { zai: createZaiProvider({ apiKey: async () => null }) },
      ledger,
      now: () => clock,
      embedding: () => embedder,
    });

  it('embeds texts with the embedding model and logs the call with its tokens and time, at no cost', async () => {
    const result = await embeddingClient({
      provider: 'local',
      model: 'granite-test',
      async embed(texts) {
        clock += 40;
        return { vectors: texts.map((text) => Float32Array.from([text.length, 1])), tokens: 12 };
      },
    }).embed({ job: 'embed-index', texts: ['one', 'three'] });

    expect(result.vectors.map((vector) => [...vector])).toEqual([
      [3, 1],
      [5, 1],
    ]);
    expect(result).toMatchObject({ provider: 'local', model: 'granite-test' });
    expect(ledger.calls).toEqual([
      {
        at: clock - 40,
        job: 'embed-index',
        tier: 'embedding',
        provider: 'local',
        model: 'granite-test',
        inputTokens: 12,
        cachedTokens: 0,
        outputTokens: 0,
        latencyMs: 40,
        costUsd: 0,
        outcome: 'ok',
      },
    ]);
  });

  it('fails as unavailable, logging nothing, while there is no embedding model', async () => {
    await expect(embeddingClient(null).embed({ job: 'embed-query', texts: ['x'] })).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(ledger.calls).toEqual([]);
  });

  it('logs a failed embedding call', async () => {
    const failing = embeddingClient({
      provider: 'local',
      model: 'granite-test',
      embed: async () => {
        throw new Error('the worker stopped');
      },
    });
    await expect(failing.embed({ job: 'embed-query', texts: ['x'] })).rejects.toMatchObject({
      kind: 'unavailable',
      message: 'The embedding failed: the worker stopped',
    });
    expect(ledger.calls).toMatchObject([{ tier: 'embedding', outcome: 'unavailable', inputTokens: 0 }]);
  });
});
