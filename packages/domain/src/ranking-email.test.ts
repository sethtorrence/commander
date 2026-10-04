import { describe, expect, it } from 'vitest';
import { NEEDS_REPLY, WAITING_ON_OTHERS } from './buckets';
import type { EmailDetail } from './email';
import type { Item } from './items';
import { type RankingContext, rankByBandRules } from './ranking';

// The band rules for email (#137), at a fixed local time: Thursday 1 October 2026, 11:40. A thread
// reaches the Dashboard by its latest message: in Needs reply it goes to Today; in Waiting on others
// with no answer for 3 days, to Waiting on others. Other Buckets and Unsorted stay in the Section.

const NOW = new Date(2026, 9, 1, 11, 40).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const context: RankingContext = { now: NOW, users: {} };

function email(id: string, fields: Partial<EmailDetail> = {}, rest: Partial<Item> = {}): Item {
  return {
    id,
    kind: 'email',
    source: 'gmail',
    account: 'google:alex',
    externalId: `m-${id}`,
    title: `Subject ${id}`,
    people: [],
    filing: null,
    status: 'open',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    detail: {
      kind: 'email',
      messageId: `<${id}@mail.test>`,
      inReplyTo: null,
      references: [],
      threadKey: `mid:<${id}@mail.test>`,
      sourceThreadId: null,
      from: { name: 'Dana Whitfield', address: 'dana@northwind.test' },
      to: [{ name: 'Alex Kim', address: 'alex@gmail.test' }],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: `Subject ${id}`,
      sentAt: NOW - HOUR,
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
    },
    ...rest,
  };
}

const needsReply = { bucketId: NEEDS_REPLY, sortedBy: 'user' } as const;
const waiting = { bucketId: WAITING_ON_OTHERS, sortedBy: 'user' } as const;

describe('email on the Dashboard', () => {
  it('puts Needs reply in Today, saying who is waiting and since when', () => {
    const tuesday = new Date(2026, 8, 29, 16, 5).getTime();
    expect(
      rankByBandRules(
        [
          email('dana', { bucket: needsReply, sentAt: tuesday }),
          email('leo', {
            bucket: needsReply,
            sentAt: NOW - 2 * HOUR,
            from: { name: null, address: 'leo@contoso.test' },
          }),
        ],
        context,
      ),
    ).toEqual([
      { itemId: 'leo', band: 'today', reason: 'leo’s waiting on your reply since 09:40', rank: 1 },
      { itemId: 'dana', band: 'today', reason: 'Dana’s waiting on your reply since Tuesday', rank: 2 },
    ]);
  });

  it('puts Waiting on others in Waiting on others once there has been no answer for 3 days', () => {
    const sent = {
      sentByMe: true,
      from: { name: 'Alex Kim', address: 'alex@gmail.test' },
      to: [{ name: 'Leo Brandt', address: 'leo@contoso.test' }],
    };
    expect(
      rankByBandRules(
        [
          email('old', { ...sent, bucket: waiting, sentAt: NOW - 4 * DAY - HOUR }),
          email('recent', { ...sent, bucket: waiting, sentAt: NOW - 2 * DAY }),
        ],
        context,
      ),
    ).toEqual([{ itemId: 'old', band: 'waiting', reason: 'No reply from Leo for 4 days', rank: 1 }]);
  });

  it('leaves other Buckets, Unsorted, archived, snoozed and Trashed mail in the Section', () => {
    expect(
      rankByBandRules(
        [
          email('receipt', { bucket: { bucketId: 'receipts', sortedBy: 'rule' } }),
          email('unsorted'),
          email('unsorted-by-hand', { bucket: { bucketId: null, sortedBy: 'user' } }),
          email('archived', { bucket: needsReply, inInbox: false }, { status: 'archived' }),
          email('snoozed', { bucket: needsReply, snooze: { until: NOW + HOUR, returned: false } }),
          email('trashed', { bucket: needsReply, inTrash: true }, { status: 'archived' }),
        ],
        context,
      ),
    ).toEqual([]);
  });
});
