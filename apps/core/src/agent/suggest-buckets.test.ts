import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActionContext, type Enqueue, SORT_INTO_BUCKETS, SUGGEST_BUCKETS } from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { createUpdateQueue, type UpdateQueue } from '../updates/queue';
import { allowCloudMail, DAY, deliver, type MailInput, moveThread } from './fixtures/emails';
import { createJobRunner, type JobRunner } from './runner';
import { suggestBucketsJob } from './suggest-buckets';

// "Suggest new Buckets" (#141): weekly, when the machine is idle, Ares looks over the week's
// corrections of his sorting and his unsure sorts, and may propose a Bucket the User doesn't have, as
// an Update item. He never adds one himself. A real Item store and gate; a fake model.

const T = Date.UTC(2026, 9, 7, 9);
const ares: ActionContext = { by: { kind: 'ares' } };

let dir: string;
let clock: number;
let store: ItemStore;
let gate: Gate;
let runner: JobRunner;
let calls: ProviderRequest[];
let reply: unknown;
let queued: Enqueue[];
let queue: UpdateQueue;
let next = 1;

const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    return {
      text: JSON.stringify({ steering: [], ...(reply as object) }),
      usage: { inputTokens: 1500, cachedTokens: 0, outputTokens: 60 },
    };
  },
  stream: () => Promise.reject(new Error('not used')),
};

const prompts = () => calls.map((call) => call.messages.at(-1)?.content ?? '');

// An email Ares sorted into `from` that the User moved to `to`.
function corrected(mail: Omit<MailInput, 'id'>, from: string, to: string) {
  const id = `m${next++}`;
  const itemId = deliver(store, clock, [{ id, ...mail }])[id] as string;
  store.record(
    { type: 'edit-fields', itemId, fields: { bucket: { bucketId: from, sortedBy: 'ares' } } },
    ares,
  );
  moveThread(store, itemId, to);
  return itemId;
}

// An email Ares wasn't sure about: his suggestion, with a low confidence.
function unsure(mail: Omit<MailInput, 'id'>, bucketId: string, confidence: number) {
  const id = `m${next++}`;
  const itemId = deliver(store, clock, [{ id, ...mail }])[id] as string;
  gate.propose({
    action: SORT_INTO_BUCKETS,
    actionKind: 'organise',
    section: 'email',
    itemId,
    itemActions: [{ type: 'edit-fields', itemId, fields: { bucket: { bucketId, sortedBy: 'ares' } } }],
    confidence,
    reason: 'A guess',
  });
  return itemId;
}

const investor = (n: number) => ({
  from: { name: `Investor ${n}`, address: `partner${n}@vc${n}.test` },
  subject: `Q3 investor update ${n}`,
  text: 'Here are our questions about the quarter and the board deck.',
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-suggest-buckets-'));
  clock = T;
  calls = [];
  queued = [];
  reply = { bucket: null };
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  allowCloudMail(store);
  queue = createUpdateQueue({ store: store.updates });
  gate = openGate({ itemStore: store });
  gate.registerAction({ action: SORT_INTO_BUCKETS, actionKind: 'organise', name: 'Sort into Buckets' });
  runner = createJobRunner({
    jobs: [
      suggestBucketsJob(store, {
        now: () => clock,
        enqueue: (line) => {
          queued.push(line);
          return queue.enqueue(line);
        },
      }),
    ],
    client: createModelClient({
      settings: () => store.models.settings(),
      providers: { zai: provider },
      ledger: store.models,
      now: () => clock,
    }),
    gate,
    store: store.agent,
    now: () => clock,
    log: () => {},
  });
});

afterEach(() => {
  runner.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function idle() {
  runner.trigger({ kind: 'idle' });
  await runner.settled();
}

describe('Suggest new Buckets', () => {
  it('waits for enough of the week’s corrections and unsure sorts', async () => {
    corrected(investor(1), 'fyi', 'needs-reply');
    unsure(investor(2), 'fyi', 0.4);
    await idle();
    expect(calls).toHaveLength(0);
  });

  it('proposes a Bucket the User doesn’t have as an Update item, and adds nothing', async () => {
    corrected(investor(1), 'fyi', 'needs-reply');
    corrected(investor(2), 'newsletters', 'needs-reply');
    unsure(investor(3), 'fyi', 0.4);
    // An old correction and a sure sort are not what he looks at.
    clock = T - 10 * DAY;
    corrected({ subject: 'Old one' }, 'fyi', 'receipts');
    clock = T;
    unsure({ subject: 'Sure one' }, 'receipts', 0.7);
    reply = {
      bucket: {
        name: 'Investors',
        description: 'Updates and questions from our investors',
        reason: 'You moved three investor emails I put elsewhere',
      },
    };

    await idle();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.reasoningEffort).toBe('low');
    const [prompt] = prompts() as [string];
    // The Buckets and the User's answers are the User's own; each email is outside, in its own block.
    expect(prompt).toMatch(/label="Buckets" source="the User">/);
    expect(prompt).toMatch(/label="The User’s answers and Ares’s unsure sorts" source="the User">/);
    expect(prompt.match(/source="outside"/g)).toHaveLength(3);
    expect(prompt).toContain(': Ares put it in FYI; the User moved it to Needs reply');
    expect(prompt).toContain('E3: Ares wasn’t sure (0.4): FYI');
    expect(prompt).not.toContain('Old one');
    expect(prompt).not.toContain('Sure one');

    expect(queued).toEqual([
      expect.objectContaining({
        group: 'decision',
        section: 'email',
        mergeKey: 'bucket-suggestion:investors',
        about: {
          kind: 'bucket-suggestion',
          name: 'Investors',
          description: 'Updates and questions from our investors',
          reason: 'You moved three investor emails I put elsewhere',
        },
      }),
    ]);
    expect(store.buckets().map((bucket) => bucket.name)).not.toContain('Investors');
    expect(store.models.usageSummary().byJob.map((row) => row.job)).toEqual([SUGGEST_BUCKETS]);
  });

  it('never proposes a Bucket the User has, nor one they dismissed, and looks once a week', async () => {
    for (let n = 1; n <= 3; n++) corrected(investor(n), 'fyi', 'needs-reply');
    reply = { bucket: { name: 'receipts', description: 'Again', reason: 'x' } };
    await idle();
    expect(calls).toHaveLength(1);
    expect(queued).toEqual([]);

    // The same week: he doesn't look again.
    for (let n = 4; n <= 6; n++) corrected(investor(n), 'fyi', 'needs-reply');
    await idle();
    expect(calls).toHaveLength(1);

    // A week on, with new corrections, he does.
    clock = T + 8 * DAY;
    for (let n = 7; n <= 9; n++) corrected(investor(n), 'fyi', 'needs-reply');
    reply = { bucket: { name: 'Investors', description: 'From investors', reason: 'Investor mail' } };
    await idle();
    expect(calls).toHaveLength(2);
    expect(queued.map((line) => line.mergeKey)).toEqual(['bucket-suggestion:investors']);

    // Dismissed, the same Bucket never comes back.
    const [line] = queue.list().filter((each) => each.about.kind === 'bucket-suggestion');
    queue.act(line?.id as number, 'dismiss');
    clock = T + 16 * DAY;
    for (let n = 10; n <= 12; n++) corrected(investor(n), 'fyi', 'needs-reply');
    await idle();
    expect(calls).toHaveLength(3);
    expect(queued).toHaveLength(1);
  });
});
