import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, AresStatus, Item } from '@commander/domain';
import {
  createModelClient,
  ModelError,
  type ModelProviderAdapter,
  type ProviderRequest,
} from '@commander/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { type AgentJob, createJobRunner, type JobRunner } from './runner';

// The job runner through its interface, on a real Item store, gate and model client over a temporary
// database. Only the model is fake: a provider adapter that answers from a script, so the client's
// own validation, cap and usage ledger are the real ones.

const user: ActionContext = { by: { kind: 'user' } };

let dir: string;
let clock: number;
let store: ItemStore;
let gate: Gate;
let runner: JobRunner | null;
let calls: ProviderRequest[];
let script: Array<string | Error | Promise<string>>;
let logged: string[];
let statuses: AresStatus[];
let note: string;

const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    const next = script.shift() ?? '{"todos":[]}';
    if (next instanceof Error) throw next;
    return { text: await next, usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 20 } };
  },
  stream: () => Promise.reject(new Error('not used')),
};

function openStore() {
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  gate = openGate({ itemStore: store });
}

const client = () =>
  createModelClient({
    settings: () => store.models.settings(),
    providers: { zai: provider },
    ledger: store.models,
    now: () => clock,
  });

function writeBlock(text: string, position = `a${Math.random().toString(36).slice(2, 8)}`): string {
  return store.record(
    {
      type: 'create',
      item: {
        kind: 'block',
        title: text,
        detail: { kind: 'block', dailyNoteId: note, parentId: null, position, text, folded: false },
      },
    },
    user,
  ).itemId;
}

const blockText = (id: string) => {
  const detail = store.get(id)?.item.detail;
  return detail?.kind === 'block' ? detail.text : '';
};

// A job like Ares's real ones, kept small: it looks at the Blocks it is triggered for (or, on request,
// every Block it was given) and proposes a Todo for each one the model names.
const todoReply = z.object({
  todos: z.array(
    z.object({ ref: z.string(), title: z.string().min(1), confidence: z.number().min(0).max(1) }),
  ),
});

function noteJob(
  overrides: Partial<
    AgentJob<{ items: { itemId: string; fingerprint: string }[] }, z.infer<typeof todoReply>>
  > = {},
  pool: () => string[] = () => [],
): AgentJob<{ items: { itemId: string; fingerprint: string }[] }, z.infer<typeof todoReply>> {
  return {
    job: 'note-todos',
    name: 'Note Todos',
    tier: 'quick',
    action: { action: 'note-todos', actionKind: 'organise', section: 'notes' },
    triggers: { typing: { pauseMs: 20_000 }, idle: true, 'source-sync': true, 'items-arrived': true },
    gather({ triggers, seen }) {
      const ids = new Set<string>(pool());
      for (const trigger of triggers) if ('itemIds' in trigger) for (const id of trigger.itemIds) ids.add(id);
      const items = [...ids]
        .map((itemId) => ({ itemId, fingerprint: blockText(itemId) }))
        .filter(({ itemId, fingerprint }) => !seen(itemId, fingerprint));
      return { items };
    },
    prompt: (input) => ({
      instructions: 'Name the Blocks that are things to do.',
      data: [
        {
          label: 'Blocks',
          from: input.items.map((item) => store.get(item.itemId)?.item as Item),
          text: input.items.map((item, i) => `B${i + 1}: ${blockText(item.itemId)}`).join('\n'),
        },
      ],
    }),
    output: todoReply,
    proposals(output, input) {
      const dropped: string[] = [];
      const proposals = output.todos.flatMap((todo) => {
        const item = input.items[Number(todo.ref.slice(1)) - 1];
        if (!item) {
          dropped.push(`no Block ${todo.ref}`);
          return [];
        }
        return [
          {
            itemId: item.itemId,
            itemActions: [
              {
                type: 'create' as const,
                item: {
                  kind: 'todo' as const,
                  title: todo.title,
                  detail: { kind: 'todo' as const, origin: 'ares' as const, dueOn: null, backedBy: null },
                },
              },
              { type: 'link' as const, from: { step: 0 }, linkType: 'made-from' as const, to: item.itemId },
            ],
            confidence: todo.confidence,
            reason: `You wrote “${blockText(item.itemId)}”`,
          },
        ];
      });
      return { proposals, dropped };
    },
    ...overrides,
  };
}

function start(jobs: AgentJob[], options: { concurrency?: number } = {}) {
  runner = createJobRunner({
    jobs,
    client: client(),
    gate,
    store: store.agent,
    now: () => clock,
    log: (message) => logged.push(message),
    onStatus: (status) => statuses.push(status),
    ...options,
  });
  return runner;
}

const reply = (todos: { ref: string; title: string; confidence: number }[]) => JSON.stringify({ todos });
const todos = () => store.query({ kinds: ['todo'] }).map((todo) => todo.title);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-runner-'));
  clock = Date.UTC(2026, 9, 3, 9);
  calls = [];
  script = [];
  logged = [];
  statuses = [];
  runner = null;
  openStore();
  note = store.ensureDailyNote('2026-10-03', user).id;
});

afterEach(() => {
  runner?.stop();
  vi.useRealTimers();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('running a job', () => {
  it('registers each job’s action with the gate when it starts', () => {
    start([noteJob()]);
    expect(gate.actions()).toEqual([
      expect.objectContaining({ action: 'note-todos', actionKind: 'organise', name: 'Note Todos' }),
    ]);
  });

  it('on request: one model call under the job’s name, its output handed to the gate as proposals', async () => {
    const dana = writeBlock('need to send Dana the Q3 numbers');
    script.push(reply([{ ref: 'B1', title: 'Send Dana the Q3 numbers', confidence: 0.95 }]));
    start([noteJob({}, () => [dana])]);

    runner?.run('note-todos');
    await runner?.settled();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.json).toBe(true);
    expect(calls[0]?.reasoningEffort).toBe('low');
    expect(store.models.usageSummary().byJob).toEqual([
      expect.objectContaining({ job: 'note-todos', calls: 1 }),
    ]);
    // Confident, under Organise's default (Auto when sure): carried out by the gate as Ares.
    expect(todos()).toEqual(['Send Dana the Q3 numbers']);
    expect(gate.activity()).toEqual([
      expect.objectContaining({ action: 'note-todos', itemId: dana, decision: 'auto', status: 'done' }),
    ]);
  });

  it('routes every proposal through the gate: unsure ones wait as suggestions, refused ones are logged', async () => {
    const dana = writeBlock('need to send Dana the Q3 numbers');
    const flights = writeBlock('maybe book flights');
    script.push(
      reply([
        { ref: 'B1', title: 'Send Dana the Q3 numbers', confidence: 0.95 },
        { ref: 'B2', title: 'Book flights', confidence: 0.4 },
        { ref: 'B9', title: 'Something the input never had', confidence: 1 },
      ]),
    );
    // A job bug: it proposes deleting the Block, which Organise may not do. The gate refuses it.
    const sneaky = noteJob(
      {
        proposals: (output, input) => ({
          proposals: [
            ...(noteJob().proposals?.(output, input).proposals ?? []),
            {
              itemId: dana,
              itemActions: [{ type: 'delete', itemId: dana }],
              confidence: 1,
              reason: 'Tidy up',
            },
          ],
          dropped: noteJob().proposals?.(output, input).dropped ?? [],
        }),
      },
      () => [dana, flights],
    );
    start([sneaky]);

    runner?.run('note-todos');
    await runner?.settled();

    expect(todos()).toEqual(['Send Dana the Q3 numbers']);
    expect(gate.activity({ statuses: ['pending'] })).toEqual([
      expect.objectContaining({ itemId: flights, decision: 'ask', reason: 'You wrote “maybe book flights”' }),
    ]);
    expect(store.get(dana)?.item.deletedAt).toBeNull();
    expect(logged).toEqual([
      expect.stringContaining('dropped a suggestion: no Block B9'),
      expect.stringContaining('the gate refused a proposal'),
    ]);
  });
});

describe('triggers', () => {
  it('runs a job about 20 seconds after the User stops typing, once, on every Block typed in meanwhile', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = writeBlock('need to send Dana');
    const second = writeBlock('call the bank');
    start([noteJob()]);

    runner?.trigger({ kind: 'typing', itemIds: [first] });
    vi.advanceTimersByTime(15_000);
    runner?.trigger({ kind: 'typing', itemIds: [second] });
    vi.advanceTimersByTime(19_000);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(1_000);
    await runner?.settled();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages.at(-1)?.content).toContain('B1: need to send Dana');
    expect(calls[0]?.messages.at(-1)?.content).toContain('B2: call the bank');
  });

  it('runs the jobs that listen for a Source sync, Items arriving and the machine idle', async () => {
    const block = writeBlock('renew passport');
    const onSync = noteJob({ job: 'on-sync', name: 'On sync', triggers: { 'source-sync': true } }, () => [
      block,
    ]);
    const onIdle = noteJob(
      {
        job: 'on-idle',
        name: 'On idle',
        action: { action: 'on-idle', actionKind: 'organise', section: null },
        triggers: { idle: true },
      },
      () => [block],
    );
    start([onSync, onIdle]);

    runner?.trigger({ kind: 'source-sync', source: 'linear', account: 'acme' });
    await runner?.settled();
    expect(store.models.usageSummary().byJob.map((row) => row.job)).toEqual(['on-sync']);

    runner?.trigger({ kind: 'idle' });
    await runner?.settled();
    expect(
      store.models
        .usageSummary()
        .byJob.map((row) => row.job)
        .sort(),
    ).toEqual(['on-idle', 'on-sync']);

    runner?.trigger({ kind: 'items-arrived', itemIds: [block] });
    await runner?.settled();
    expect(calls).toHaveLength(2);
  });
});

describe('the queue', () => {
  it('runs a job queued twice for the same Items once', async () => {
    const block = writeBlock('renew passport');
    let answer: (text: string) => void = () => {};
    script.push(new Promise((resolve) => (answer = resolve)));
    const other = noteJob(
      { job: 'other', name: 'Other', action: { action: 'other', actionKind: 'organise', section: null } },
      () => [block],
    );
    // This one would look at its Items every time, seen or not: only the queue keeps it to one run.
    const eager = noteJob({ gather: () => ({ items: [{ itemId: block, fingerprint: 'renew passport' }] }) });
    start([other, eager], { concurrency: 1 });

    runner?.run('other'); // holds the only slot until answered
    runner?.trigger({ kind: 'items-arrived', itemIds: [block] });
    runner?.trigger({ kind: 'items-arrived', itemIds: [block] });
    runner?.run('note-todos');
    expect(runner?.status().running).toEqual(['Other']);
    answer('{"todos":[]}');
    await runner?.settled();

    expect(calls.map((call) => call.messages.length)).toHaveLength(2);
    expect(store.models.usageSummary().byJob).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ job: 'other', calls: 1 }),
        expect.objectContaining({ job: 'note-todos', calls: 1 }),
      ]),
    );
  });

  it('runs at most `concurrency` jobs at once, and never two runs of one job', async () => {
    writeBlock('renew passport');
    const everyBlock = () => store.blocks([note]).map((block) => block.id);
    const jobs = ['a', 'b', 'c'].map((name) =>
      noteJob(
        {
          job: name,
          name: name.toUpperCase(),
          action: { action: name, actionKind: 'organise', section: null },
        },
        everyBlock,
      ),
    );
    const answers: ((text: string) => void)[] = [];
    for (let i = 0; i < 4; i++) script.push(new Promise((resolve) => answers.push(resolve)));
    start(jobs, { concurrency: 2 });

    runner?.run('a');
    runner?.run('b');
    runner?.run('c');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(runner?.status()).toEqual({ working: true, running: ['A', 'B'] });
    // Asked again while running (with something new to look at): once more afterwards, not alongside.
    writeBlock('call the bank');
    runner?.run('a');
    answers[0]?.('{"todos":[]}');
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(runner?.status().running).toEqual(['B', 'C']);
    answers[1]?.('{"todos":[]}');
    answers[2]?.('{"todos":[]}');
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    answers[3]?.('{"todos":[]}');
    await runner?.settled();

    expect(runner?.status()).toEqual({ working: false, running: [] });
    expect(statuses.at(0)).toEqual({ working: true, running: ['A'] });
    expect(statuses.at(-1)).toEqual({ working: false, running: [] });
  });
});

describe('what the model says', () => {
  it('discards a reply that doesn’t fit the schema (after one retry), and acts on nothing', async () => {
    const block = writeBlock('need to send Dana the Q3 numbers');
    script.push(
      '{"todos":[{"ref":"B1","title":"","confidence":7}]}',
      'Sure! Here are your todos: send Dana the numbers.',
    );
    start([noteJob({}, () => [block])]);

    runner?.run('note-todos');
    await runner?.settled();

    expect(calls).toHaveLength(2);
    expect(todos()).toEqual([]);
    expect(gate.activity()).toEqual([]);
    expect(runner?.jobs()).toEqual([
      expect.objectContaining({ job: 'note-todos', lastOutcome: 'invalid-reply' }),
    ]);
    expect(logged).toEqual([expect.stringContaining('invalid-reply')]);
    // Not remembered as looked at: the next trigger tries again.
    script.push(reply([{ ref: 'B1', title: 'Send Dana the Q3 numbers', confidence: 0.9 }]));
    runner?.run('note-todos');
    await runner?.settled();
    expect(todos()).toEqual(['Send Dana the Q3 numbers']);
  });

  it('skips a call the month’s cap stops, and runs it again on the next trigger', async () => {
    const block = writeBlock('need to send Dana the Q3 numbers');
    script.push(new ModelError('over-cap', 'This month’s model spend has reached the cap.'));
    start([noteJob({}, () => [block])]);

    runner?.trigger({ kind: 'idle' });
    await runner?.settled();
    expect(todos()).toEqual([]);
    expect(runner?.jobs()).toEqual([
      expect.objectContaining({
        lastOutcome: 'over-cap',
        lastProblem: 'This month’s model spend has reached the cap.',
      }),
    ]);

    script.push(reply([{ ref: 'B1', title: 'Send Dana the Q3 numbers', confidence: 0.9 }]));
    runner?.trigger({ kind: 'idle' });
    await runner?.settled();
    expect(todos()).toEqual(['Send Dana the Q3 numbers']);
    expect(runner?.jobs()).toEqual([expect.objectContaining({ lastOutcome: 'ok', lastProblem: null })]);
  });

  it('waits longer after repeated failures, though a request always runs', async () => {
    const block = writeBlock('need to send Dana the Q3 numbers');
    script.push(
      new ModelError('unavailable', 'Z.ai is down'),
      new ModelError('unavailable', 'Z.ai is down'),
      reply([{ ref: 'B1', title: 'Send Dana the Q3 numbers', confidence: 0.9 }]),
    );
    start([noteJob({}, () => [block])]);

    runner?.trigger({ kind: 'idle' });
    await runner?.settled();
    runner?.trigger({ kind: 'idle' });
    await runner?.settled();
    expect(calls).toHaveLength(2);

    // Two failures in a row: automatic triggers wait a minute.
    clock += 30_000;
    runner?.trigger({ kind: 'idle' });
    await runner?.settled();
    expect(calls).toHaveLength(2);
    runner?.run('note-todos');
    await runner?.settled();
    expect(calls).toHaveLength(3);
    expect(todos()).toEqual(['Send Dana the Q3 numbers']);
  });
});

describe('a missing key or the cap', () => {
  it('never builds up a wait: the first trigger after the key is added runs', async () => {
    const block = writeBlock('need to send Dana the Q3 numbers');
    for (let i = 0; i < 4; i++) script.push(new ModelError('no-key', 'No Z.ai API key is saved.'));
    start([noteJob({}, () => [block])]);
    for (let i = 0; i < 4; i++) {
      runner?.trigger({ kind: 'idle' });
      await runner?.settled();
    }
    expect(runner?.jobs()).toEqual([
      expect.objectContaining({ lastOutcome: 'failed', lastProblem: 'No Z.ai API key is saved.' }),
    ]);

    script.push(reply([{ ref: 'B1', title: 'Send Dana the Q3 numbers', confidence: 0.9 }]));
    runner?.trigger({ kind: 'idle' });
    await runner?.settled();
    expect(todos()).toEqual(['Send Dana the Q3 numbers']);
  });
});

describe('what the User decides', () => {
  it('doesn’t run a job whose action is Off, nor one switched off in Settings', async () => {
    const block = writeBlock('need to send Dana the Q3 numbers');
    start([noteJob({}, () => [block])]);

    gate.setLevel({ scope: 'action', action: 'note-todos' }, 'off');
    runner?.run('note-todos');
    await runner?.settled();
    expect(calls).toHaveLength(0);

    gate.setLevel({ scope: 'action', action: 'note-todos' }, null);
    expect(runner?.setEnabled('note-todos', false)).toEqual([expect.objectContaining({ enabled: false })]);
    runner?.run('note-todos');
    await runner?.settled();
    expect(calls).toHaveLength(0);

    runner?.setEnabled('note-todos', true);
    runner?.run('note-todos');
    await runner?.settled();
    expect(calls).toHaveLength(1);
  });
});

describe('across runs and restarts', () => {
  it('never looks at the same Item as it is twice, and remembers that (and the switch) across a restart', async () => {
    const block = writeBlock('need to send Dana the Q3 numbers');
    script.push(reply([{ ref: 'B1', title: 'Send Dana the Q3 numbers', confidence: 0.4 }]));
    start([noteJob({}, () => [block])]);
    runner?.run('note-todos');
    await runner?.settled();
    expect(calls).toHaveLength(1);
    runner?.setEnabled('note-todos', true);

    // Restart on the same data.
    runner?.stop();
    store.close();
    openStore();
    start([noteJob({}, () => [block])]);
    expect(gate.actions()).toEqual([expect.objectContaining({ action: 'note-todos' })]);
    runner?.run('note-todos');
    await runner?.settled();
    expect(calls).toHaveLength(1);
    expect(runner?.jobs()).toEqual([expect.objectContaining({ lastOutcome: 'nothing-to-do' })]);
    expect(gate.activity()).toHaveLength(1);

    // Changed text is new to it.
    store.record(
      {
        type: 'update',
        itemId: block,
        changes: {
          detail: {
            kind: 'block',
            dailyNoteId: note,
            parentId: null,
            position: 'a0',
            text: 'send Dana the Q4 numbers',
            folded: false,
          },
        },
      },
      user,
    );
    runner?.run('note-todos');
    await runner?.settled();
    expect(calls).toHaveLength(2);
  });
});

describe('Todos changing', () => {
  it('runs a job that listens a few seconds after the Todos last changed, once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const block = writeBlock('renew passport');
    start([
      noteJob({
        triggers: { 'todos-changed': { pauseMs: 5_000 } },
        gather: ({ triggers }) => ({
          items: [
            { itemId: block, fingerprint: triggers.flatMap((t) => ('itemIds' in t ? t.itemIds : [])).join() },
          ],
        }),
      }),
    ]);

    runner?.trigger({ kind: 'todos-changed', itemIds: ['todo-1'] });
    vi.advanceTimersByTime(4_000);
    runner?.trigger({ kind: 'todos-changed', itemIds: ['todo-2'] });
    vi.advanceTimersByTime(4_000);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(1_000);
    await runner?.settled();
    expect(calls).toHaveLength(1);
  });
});

describe('batches', () => {
  it('sends a big input in several calls, each with its own part, and acts on every part’s reply', async () => {
    const blocks = ['call the bank', 'renew passport', 'book flights'].map((text) => writeBlock(text));
    script.push(
      reply([{ ref: 'B1', title: 'Call the bank', confidence: 0.95 }]),
      reply([{ ref: 'B1', title: 'Book flights', confidence: 0.95 }]),
    );
    const job = noteJob(
      {
        batch: (input) => [{ items: input.items.slice(0, 2) }, { items: input.items.slice(2) }],
      },
      () => blocks,
    );
    start([job]);

    runner?.run('note-todos');
    await runner?.settled();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.messages.at(-1)?.content).toContain('B2: renew passport');
    expect(calls[1]?.messages.at(-1)?.content).toContain('B1: book flights');
    expect(calls[1]?.messages.at(-1)?.content).not.toContain('renew passport');
    expect(todos().sort()).toEqual(['Book flights', 'Call the bank']);
    expect(store.models.usageSummary().byJob).toEqual([
      expect.objectContaining({ job: 'note-todos', calls: 2 }),
    ]);
  });
});

describe('a job whose result is a view (ranking)', () => {
  const applyJob = (applied: unknown[][], blocks: () => string[]) =>
    noteJob(
      {
        job: 'view',
        name: 'View',
        action: { action: 'view', actionKind: 'organise', section: null },
        batch: (input) => input.items.map((item) => ({ items: [item] })),
        proposals: undefined,
        apply(answers) {
          applied.push(answers.map(({ output, input }) => [output.todos.length, input.items.length]));
          return { dropped: ['B7 was never given'] };
        },
      },
      blocks,
    );

  it('applies every part’s reply at once, without the gate, at any level above Off', async () => {
    const blocks = [writeBlock('call the bank'), writeBlock('renew passport')];
    script.push(reply([{ ref: 'B1', title: 'x', confidence: 1 }]), reply([]));
    const applied: unknown[][] = [];
    start([applyJob(applied, () => blocks)]);
    gate.setLevel({ scope: 'action', action: 'view' }, 'ask');

    runner?.run('view');
    await runner?.settled();

    expect(applied).toEqual([
      [
        [1, 1],
        [0, 1],
      ],
    ]);
    expect(gate.activity()).toEqual([]);
    expect(todos()).toEqual([]);
    expect(logged).toEqual([expect.stringContaining('B7 was never given')]);
    expect(runner?.jobs()).toEqual([expect.objectContaining({ lastOutcome: 'ok' })]);

    gate.setLevel({ scope: 'action', action: 'view' }, 'off');
    runner?.run('view');
    await runner?.settled();
    expect(applied).toHaveLength(1);
  });

  it('applies nothing when one part’s call fails', async () => {
    const blocks = [writeBlock('call the bank'), writeBlock('renew passport')];
    script.push(reply([]), new ModelError('unavailable', 'Z.ai is down'));
    const applied: unknown[][] = [];
    start([applyJob(applied, () => blocks)]);

    runner?.run('view');
    await runner?.settled();

    expect(applied).toEqual([]);
    expect(runner?.jobs()).toEqual([
      expect.objectContaining({ lastOutcome: 'failed', lastProblem: 'Z.ai is down' }),
    ]);
  });
});
