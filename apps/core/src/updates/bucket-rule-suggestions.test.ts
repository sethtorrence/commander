import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActionContext, bucketRuleSuggestionDraft, type EmailAddress } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deliver, moveThread } from '../agent/fixtures/emails';
import { type ItemStore, openItemStore } from '../item-store';
import { createBucketRuleSuggestions } from './bucket-rule-suggestions';
import { lineTemplate } from './kinds';
import { createUpdateQueue, type UpdateQueue } from './queue';

// Bucket Rule suggestions (#141): once the User's answers to Ares's sorting point one sender
// address, domain or mailing list at one Bucket five times, he queues "Always put mail from
// stripe.com in Receipts?" for the Update. On a real database, with the answers recorded as the Item
// store records them.

const ares: ActionContext = { by: { kind: 'ares' } };
const T = Date.UTC(2026, 9, 7, 9);

let dir: string;
let store: ItemStore;
let queue: UpdateQueue;
let suggestions: ReturnType<typeof createBucketRuleSuggestions>;
let next = 1;

// An email from this sender that Ares sorted into `from` and the User moved to `to` (a correction),
// or kept there (a confirmation, when `to` is the same).
function answer(sender: EmailAddress, from: string, to: string | null, listId: string | null = null) {
  const id = `m${next++}`;
  const ids = deliver(store, T, [{ id, from: sender, subject: `Mail ${id}`, listId }]);
  const itemId = ids[id] as string;
  store.record(
    { type: 'edit-fields', itemId, fields: { bucket: { bucketId: from, sortedBy: 'ares' } } },
    ares,
  );
  moveThread(store, itemId, to);
  return itemId;
}

const queued = () => queue.list().filter((line) => line.about.kind === 'bucket-rule-suggestion');
const stripe = (local: string) => ({ name: 'Stripe', address: `${local}@stripe.com` });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-bucket-rule-suggestions-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => T,
  });
  queue = createUpdateQueue({ store: store.updates });
  suggestions = createBucketRuleSuggestions({ itemStore: store, queue });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Bucket Rule suggestions', () => {
  it('five consistent answers about one domain queue "Always put mail from stripe.com in Receipts?"', () => {
    for (const local of ['receipts', 'invoices', 'billing', 'receipts'])
      answer(stripe(local), 'newsletters', 'receipts');
    suggestions.sweep();
    expect(queued()).toEqual([]);

    // The fifth: a confirmation counts as much as a correction.
    answer(stripe('receipts'), 'receipts', 'receipts');
    suggestions.sweep();

    const [line] = queued();
    expect(line).toMatchObject({
      group: 'decision',
      section: 'email',
      mergeKey: 'bucket-rule-suggestion:gmail.domain:stripe.com:receipts',
      about: {
        kind: 'bucket-rule-suggestion',
        field: 'gmail.domain',
        value: 'stripe.com',
        label: 'stripe.com',
        bucketId: 'receipts',
        name: 'Receipts',
        count: 5,
      },
    });
    expect(line?.itemIds).toHaveLength(5);
    expect(lineTemplate(line as never, {} as never)).toBe(
      'You put 5 emails from stripe.com in Receipts. Always put mail from stripe.com in Receipts? A Bucket Rule would do it for you from now on: make the Rule, or dismiss this and I won’t ask again.',
    );
    // Only one suggestion: not the address (three of five), nor the same thing twice.
    expect(queued()).toHaveLength(1);
    suggestions.sweep();
    expect(queued()).toHaveLength(1);

    // Accepting makes this Rule.
    expect(bucketRuleSuggestionDraft(line?.about as never)).toEqual({
      target: { kind: 'bucket', bucketId: 'receipts' },
      when: {
        join: 'and',
        terms: [{ field: 'gmail.domain', op: 'is', value: 'stripe.com', label: 'stripe.com' }],
      },
    });
  });

  it('a mailing list, or one sender address, is offered as itself when it points at the same emails', () => {
    const acme = { name: 'Acme', address: 'news@acme.test' };
    for (let i = 0; i < 5; i++) answer(acme, 'receipts', 'newsletters', 'Acme Weekly <weekly.acme.test>');
    for (let i = 0; i < 5; i++)
      answer({ name: 'Dana', address: 'dana@northwind.test' }, 'fyi', 'needs-reply');
    suggestions.sweep();
    expect(
      queued().map(
        (line) => line.about.kind === 'bucket-rule-suggestion' && `${line.about.field} ${line.about.value}`,
      ),
    ).toEqual(['gmail.list weekly.acme.test', 'gmail.from dana@northwind.test']);
  });

  it('answers that disagree, or Unsorted ones, make no suggestion', () => {
    for (let i = 0; i < 5; i++) answer(stripe('receipts'), 'newsletters', 'receipts');
    answer(stripe('receipts'), 'receipts', 'fyi');
    for (let i = 0; i < 5; i++) answer({ name: 'X', address: 'x@spam.test' }, 'fyi', null);
    suggestions.sweep();
    expect(queued()).toEqual([]);
  });

  it('a dismissed suggestion never comes back, and a value a Bucket Rule already sorts makes none', () => {
    for (let i = 0; i < 5; i++) answer(stripe('receipts'), 'newsletters', 'receipts');
    suggestions.sweep();
    const [line] = queued();
    queue.act(line?.id as number, 'dismiss');
    for (let i = 0; i < 3; i++) answer(stripe('receipts'), 'newsletters', 'receipts');
    suggestions.sweep();
    expect(queued()).toEqual([]);

    for (let i = 0; i < 5; i++) answer({ name: 'Acme', address: 'news@acme.test' }, 'fyi', 'newsletters');
    store.changeRule({
      type: 'create',
      rule: bucketRuleSuggestionDraft({
        field: 'gmail.domain',
        value: 'acme.test',
        label: 'acme.test',
        bucketId: 'newsletters',
      }),
    });
    suggestions.sweep();
    expect(queued()).toEqual([]);
  });

  it('accepting creates the Rule at the top of the list, and offers to re-sort what it matches', () => {
    store.changeRule({
      type: 'create',
      rule: bucketRuleSuggestionDraft({
        field: 'gmail.domain',
        value: 'other.test',
        label: 'other.test',
        bucketId: 'fyi',
      }),
    });
    const ids = [1, 2, 3, 4, 5].map(() => answer(stripe('receipts'), 'newsletters', 'receipts'));
    // One more from Stripe, sorted (wrongly) by Ares and never answered.
    const unanswered = deliver(store, T, [{ id: 'unanswered', from: stripe('receipts'), subject: 'Receipt' }])
      .unanswered as string;
    store.record(
      {
        type: 'edit-fields',
        itemId: unanswered,
        fields: { bucket: { bucketId: 'newsletters', sortedBy: 'ares' } },
      },
      ares,
    );
    suggestions.sweep();
    const [line] = queued();

    const change = store.changeRule({
      type: 'create',
      rule: bucketRuleSuggestionDraft(line?.about as never),
      position: 0,
    });
    expect(store.rules()[0]?.id).toBe(change.rule?.id);
    // The emails the User sorted by hand are left out of the re-sort preview; Ares's sort is in it.
    expect(change.resort.map((each) => each.item.id)).toEqual([unanswered]);
    expect(ids).toHaveLength(5);
  });
});
