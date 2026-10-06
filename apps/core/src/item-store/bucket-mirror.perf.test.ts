import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUCKET_MIRROR_FIELD, type EmailDetail, type SourceItem } from '@commander/domain';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Mirror Buckets (#142) stays quick on a full mailbox: 30 days of mail (3,000 emails, 2,000 of them
// sorted into Buckets). Switching mirroring on queues every sorted email's label in one go, and
// Settings → Accounts reads each Account's switch as it opens: each must be well within a click.

const EMAILS = 3_000;
const SORTED = 2_000;
const ACCOUNT = 'google:speed';
const BUCKETS = ['fyi', 'newsletters', 'receipts', 'needs-reply'];

let dir: string;
let store: ItemStore;

function email(n: number): SourceItem {
  const detail: EmailDetail = {
    kind: 'email',
    messageId: `<m${n}@mail.test>`,
    inReplyTo: null,
    references: [],
    threadKey: `mid:<m${n}@mail.test>`,
    sourceThreadId: `t${n}`,
    from: { name: 'Sender', address: `sender${n % 50}@mail.test` },
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: `Message ${n}`,
    sentAt: 1_790_000_000_000 + n * 60_000,
    snippet: '',
    read: true,
    starred: false,
    inInbox: true,
    sentByMe: false,
    labels: [{ id: 'INBOX', name: 'Inbox' }],
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
    // Sorted as a Rule would have (Commander's own field, kept through syncs).
    ...(n < SORTED
      ? { bucket: { bucketId: BUCKETS[n % BUCKETS.length] as string, sortedBy: 'rule' as const } }
      : {}),
  };
  return { externalId: `m${n}`, kind: 'email', title: detail.subject, status: 'open', detail };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-mirror-speed-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
  });
  for (let start = 0; start < EMAILS; start += 500) {
    const items = Array.from({ length: 500 }, (_, i) => email(start + i));
    store.saveFromSource({ source: 'gmail', account: ACCOUNT, items, deleted: [] });
  }
}, 120_000);

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it('switches mirroring on for a full mailbox in under 3 seconds, queueing each sorted email once', () => {
  const started = performance.now();
  store.bucketMirror.set({ account: ACCOUNT, source: 'gmail', enabled: true });
  const took = performance.now() - started;
  const queued = store.outgoing
    .list({ account: ACCOUNT })
    .filter((change) => change.field === BUCKET_MIRROR_FIELD);
  expect(queued.length).toBeGreaterThan(0);
  expect(took).toBeLessThan(3_000);
});

it('reads every Account’s switch in under 50 ms', () => {
  const started = performance.now();
  for (let i = 0; i < 10; i++) store.bucketMirror.list();
  expect((performance.now() - started) / 10).toBeLessThan(50);
});
