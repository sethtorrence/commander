import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SORT_INTO_BUCKETS } from '@commander/domain';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { allowCloudMail, DAY, GMAIL, HOUR, mail } from '../agent/fixtures/emails';
import { type ItemStore, openItemStore } from '.';

// Ares's sorting stays quick as mail grows (#141): 3,000 threads of two messages each in the last 30
// days, 300 with his suggestion waiting. Each sorting run and each filing run read the mail in scope,
// the Email status line reads his progress every few seconds while he sorts, and the Agent looks for
// suggestions that no longer stand after every change the User makes (each keystroke in a Daily Note).

const THREADS = 3_000;
const WAITING = 300;
const T = Date.UTC(2026, 9, 7, 9);

let dir: string;
let store: ItemStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-email-sorting-speed-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => T,
  });
  allowCloudMail(store);
  const items = Array.from({ length: THREADS }, (_, n) => {
    const at = T - (n / THREADS) * 29 * DAY;
    return [
      mail({ id: `t${n}a`, subject: `Thread ${n}`, sentAt: at - HOUR }, T),
      mail(
        {
          id: `t${n}b`,
          subject: `Re: Thread ${n}`,
          inReplyTo: `<t${n}a@mail.test>`,
          references: [`<t${n}a@mail.test>`],
          sourceThreadId: `g-t${n}a`,
          sentAt: at,
        },
        T,
      ),
    ];
  }).flat();
  for (let i = 0; i < items.length; i += 500)
    store.saveFromSource({ source: 'gmail', account: GMAIL, items: items.slice(i, i + 500), deleted: [] });
  const scope = store.emailSorting.scope(T - 30 * DAY);
  store.transaction(() => {
    for (const item of scope.slice(0, WAITING)) {
      store.autonomy.saveProposal({
        action: SORT_INTO_BUCKETS,
        actionKind: 'organise',
        section: 'email',
        itemId: item.id,
        itemActions: [
          { type: 'edit-fields', itemId: item.id, fields: { bucket: { bucketId: 'fyi', sortedBy: 'ares' } } },
        ],
        confidence: 0.5,
        reason: 'Maybe',
        causedBy: null,
        chained: false,
        conversation: null,
        decision: 'ask',
        status: 'pending',
        entryIds: [],
      });
    }
  });
}, 180_000);

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function timed<T>(run: () => T): { result: T; ms: number } {
  run();
  const started = performance.now();
  const result = run();
  return { result, ms: performance.now() - started };
}

it('reads the mail in scope (each thread’s latest message) in under 300 ms', () => {
  const { result, ms } = timed(() => store.emailSorting.scope(T - 30 * DAY));
  expect(result).toHaveLength(THREADS);
  expect(result[0]?.externalId).toBe('t0b');
  expect(ms).toBeLessThan(300);
});

it('works out his progress in under 400 ms', () => {
  const { result, ms } = timed(() => store.emailSorting.progress());
  expect(result).toEqual({ done: WAITING, total: THREADS });
  expect(ms).toBeLessThan(400);
});

it('finds the suggestions that no longer stand in under 25 ms', () => {
  const { result, ms } = timed(() => store.emailSorting.staleSuggestions());
  expect(result).toEqual([]);
  expect(ms).toBeLessThan(25);
});
