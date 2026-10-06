import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type EmailDetail,
  MIRROR_BUCKETS,
  type RuleDraft,
  SKIP_THE_INBOX,
  type SourceItem,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { type SkipInbox, setUpSkipInbox } from '.';

// Skip the inbox (#142) for mail a Rule or Ares sorts, through the gate as Tidy your Sources / "Skip the
// inbox": Ask by default (a suggestion on the email, accepted one by one or all at once, undone back to
// the inbox), archived at once at Auto; never offered twice for the same sort, never for mail already
// out of the inbox. Switching a Bucket's Skip the inbox on offers its inbox mail, only ever as
// suggestions. Mirror Buckets is registered beside it.

const T = Date.UTC(2026, 9, 7, 9);
const GMAIL = 'google:alex';

let dir: string;
let store: ItemStore;
let gate: Gate;
let skip: SkipInbox;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-skip-inbox-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => T,
  });
  gate = openGate({ itemStore: store });
  skip = setUpSkipInbox({ store, gate, log: () => {} });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function email(id: string, from = 'news@digest.test', fields: Partial<EmailDetail> = {}): SourceItem {
  const detail: EmailDetail = {
    kind: 'email',
    messageId: `<${id}@mail.test>`,
    inReplyTo: null,
    references: [],
    threadKey: `mid:<${id}@mail.test>`,
    sourceThreadId: id,
    from: { name: 'Digest', address: from },
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: `Issue ${id}`,
    sentAt: T - 3_600_000,
    snippet: '',
    read: false,
    starred: false,
    inInbox: true,
    sentByMe: false,
    labels: [{ id: 'INBOX', name: 'Inbox' }],
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
    ...fields,
  };
  return { externalId: id, kind: 'email', title: detail.subject, people: [from], status: 'open', detail };
}

const rule: RuleDraft = {
  target: { kind: 'bucket', bucketId: 'newsletters' },
  when: {
    join: 'and',
    terms: [{ field: 'gmail.domain', op: 'is', value: 'digest.test', label: 'digest.test' }],
  },
};

const save = (items: SourceItem[]) =>
  store.saveFromSource({ source: 'gmail', account: GMAIL, items, deleted: [] });
const idOf = (externalId: string) =>
  store.query({ kinds: ['email'] }).find((item) => item.externalId === externalId)?.id as string;
const inInbox = (externalId: string) =>
  (store.get(idOf(externalId))?.item.detail as EmailDetail | undefined)?.inInbox;
const suggestions = () => gate.activity({ action: SKIP_THE_INBOX, statuses: ['pending'] });
const skipping = (bucketId: string, on = true) =>
  store.changeBucket({ type: 'update', bucketId, bucket: { skipInbox: on } });

describe('Skip the inbox for a Rule’s or Ares’s sort', () => {
  it('registers Skip the inbox and Mirror Buckets as Tidy your Sources', () => {
    expect(gate.actions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: SKIP_THE_INBOX,
          actionKind: 'tidy-sources',
          name: 'Skip the inbox',
        }),
        expect.objectContaining({
          action: MIRROR_BUCKETS,
          actionKind: 'tidy-sources',
          name: 'Mirror Buckets',
        }),
      ]),
    );
  });

  it('suggests archiving (Ask by default), and Accept all archives them; undo brings one back', () => {
    skipping('newsletters');
    store.changeRule({ type: 'create', rule });
    save([email('n1'), email('n2')]);

    skip.consider([idOf('n1'), idOf('n2')]);

    expect(suggestions().map((each) => [each.itemId, each.reason])).toEqual([
      [idOf('n2'), 'Newsletters skips the inbox'],
      [idOf('n1'), 'Newsletters skips the inbox'],
    ]);
    expect(inInbox('n1')).toBe(true);
    const accepted = gate.acceptAll(suggestions().map((each) => each.id));
    expect(inInbox('n1')).toBe(false);
    expect(inInbox('n2')).toBe(false);
    expect(store.outgoing.forItem(idOf('n1')).map((row) => [row.field, row.value])).toEqual([
      ['inbox', false],
    ]);

    const first = accepted.find((each) => each.itemId === idOf('n1'));
    for (const entryId of first?.entryIds ?? [])
      store.record({ type: 'undo', entryId }, { by: { kind: 'user' } });
    expect(inInbox('n1')).toBe(true);
  });

  it('archives on arrival at Auto, as Ares, undoably', () => {
    gate.setLevel({ scope: 'action', action: SKIP_THE_INBOX }, 'auto');
    skipping('newsletters');
    store.changeRule({ type: 'create', rule });
    save([email('n1')]);

    skip.consider([idOf('n1')]);

    expect(inInbox('n1')).toBe(false);
    const [done] = gate.activity({ action: SKIP_THE_INBOX });
    expect(done).toMatchObject({ status: 'done', undoable: true });
    gate.undo(done?.id as number);
    expect(inInbox('n1')).toBe(true);
  });

  it('never offers it twice for the same sort, nor once dismissed', () => {
    skipping('newsletters');
    store.changeRule({ type: 'create', rule });
    save([email('n1')]);
    skip.consider([idOf('n1')]);
    skip.consider([idOf('n1')]);
    expect(suggestions()).toHaveLength(1);
    gate.dismiss(suggestions()[0]?.id as number);
    skip.consider([idOf('n1')]);
    expect(suggestions()).toHaveLength(0);
  });

  it('offers nothing for a Bucket that doesn’t skip the inbox, mail already archived, or the User’s own sort', () => {
    store.changeRule({ type: 'create', rule });
    save([email('n1'), email('n2', 'news@digest.test', { inInbox: false, labels: [] })]);
    skip.consider([idOf('n1')]);
    expect(suggestions()).toEqual([]);

    skipping('newsletters');
    skip.consider([idOf('n2')]);
    save([email('u1', 'dana@northwind.test')]);
    store.record(
      {
        type: 'edit-fields',
        itemId: idOf('u1'),
        fields: { bucket: { bucketId: 'newsletters', sortedBy: 'user' } },
      },
      { by: { kind: 'user' } },
    );
    skip.consider([idOf('u1')]);
    expect(suggestions()).toEqual([]);
  });
});

describe('switching a Bucket’s Skip the inbox on', () => {
  it('offers its mail still in the inbox, only ever as suggestions, even at Auto', () => {
    gate.setLevel({ scope: 'action', action: SKIP_THE_INBOX }, 'auto');
    store.changeRule({ type: 'create', rule });
    save([email('n1'), email('n2'), email('f1', 'dana@northwind.test')]);
    store.record(
      {
        type: 'edit-fields',
        itemId: idOf('f1'),
        fields: { bucket: { bucketId: 'newsletters', sortedBy: 'user' } },
      },
      { by: { kind: 'user' } },
    );
    skipping('newsletters');

    skip.bucketSwitchedOn('newsletters');

    expect(suggestions()).toHaveLength(3);
    expect(['n1', 'n2', 'f1'].map(inInbox)).toEqual([true, true, true]);
  });
});
