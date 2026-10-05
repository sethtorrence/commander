import { describe, expect, it } from 'vitest';
import type { EmailDetail } from './email';
import { emailRuleFields, isEmailRuleField } from './email-rules';
import type { Item } from './items';
import { describeRule, firstMatch, firstMatchFor, RULE_FIELDS, RULE_SOURCES, type Rule, rule } from './rules';

// Email's Rule fields (#137), shared by Gmail and Outlook: what an email can be filed into a Project
// or sorted into a Bucket by. Each `gmail.*` field reads Outlook mail too (and `outlook.*` Gmail), so a
// Rule written against one Account's mail sorts every Account's.

function email(source: 'gmail' | 'outlook', fields: Partial<EmailDetail> = {}): Item {
  return {
    id: `${source}-1`,
    kind: 'email',
    source,
    account: source === 'gmail' ? 'google:alex' : 'microsoft:alex',
    externalId: 'm-1',
    title: 'Your receipt from Stripe',
    people: [],
    filing: null,
    status: 'open',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    detail: {
      kind: 'email',
      messageId: '<1@mail.test>',
      inReplyTo: null,
      references: [],
      threadKey: 'mid:<1@mail.test>',
      sourceThreadId: null,
      from: { name: 'Stripe', address: 'Receipts@Email.Stripe.com' },
      to: [{ name: 'Alex Kim', address: 'Alex@Northwind.test' }],
      cc: [{ name: null, address: 'books@northwind.test' }],
      bcc: [],
      replyTo: [],
      subject: 'Your receipt from Stripe [#1234]',
      sentAt: 0,
      snippet: '',
      read: false,
      starred: false,
      inInbox: true,
      sentByMe: false,
      labels:
        source === 'gmail'
          ? [
              { id: 'INBOX', name: 'Inbox' },
              { id: 'UNREAD', name: 'Unread' },
              { id: 'CATEGORY_UPDATES', name: 'CATEGORY_UPDATES' },
              { id: 'Label_7', name: 'Finance' },
            ]
          : [{ id: 'folder-inbox', name: 'Inbox' }],
      attachments: [{ name: 'receipt.pdf', type: 'application/pdf', size: 10, partId: '1', inline: false }],
      hasInvitation: false,
      listUnsubscribe: null,
      listId: '<receipts.stripe.com>',
      ...fields,
    },
  };
}

const linearIssue = { kind: 'linear-issue', source: 'linear', account: 'linear:acme', title: 'x' } as Item;
const read = (id: string, item: Item) => RULE_FIELDS.get(id)?.read(item);

describe('email Rule fields', () => {
  for (const source of ['gmail', 'outlook'] as const) {
    describe(`reading ${source} mail`, () => {
      const item = email(source);
      it('reads the sender’s address, and their domain with its parents', () => {
        expect(read('gmail.from', item)).toEqual([
          { value: 'receipts@email.stripe.com', label: 'receipts@email.stripe.com' },
        ]);
        expect(read('outlook.domain', item)).toEqual([
          { value: 'email.stripe.com', label: 'email.stripe.com' },
          { value: 'stripe.com', label: 'stripe.com' },
        ]);
      });

      it('reads every to and cc address', () => {
        expect(read('gmail.to', item)?.map((each) => each.value)).toEqual([
          'alex@northwind.test',
          'books@northwind.test',
        ]);
      });

      it('reads the subject, the Account, the mailing list and attachments', () => {
        expect(read('gmail.subject', item)).toEqual([
          { value: 'Your receipt from Stripe [#1234]', label: 'Your receipt from Stripe [#1234]' },
        ]);
        expect(read('gmail.account', item)).toEqual([{ value: item.account, label: item.account }]);
        expect(read('gmail.list', item)).toEqual([
          { value: 'receipts.stripe.com', label: 'receipts.stripe.com' },
        ]);
        expect(read('gmail.attachment', item)).toEqual([{ value: 'yes', label: 'yes' }]);
        expect(read('gmail.attachment', email(source, { attachments: [] }))).toEqual([
          { value: 'no', label: 'no' },
        ]);
      });
    });
  }

  it('reads Gmail’s own labels (not its flags) and an Outlook folder alike', () => {
    expect(read('gmail.label', email('gmail'))).toEqual([
      { value: 'CATEGORY_UPDATES', label: 'Updates' },
      { value: 'Label_7', label: 'Finance' },
    ]);
    expect(read('outlook.label', email('outlook'))).toEqual([{ value: 'folder-inbox', label: 'Inbox' }]);
  });

  it('reads nothing of other Items', () => {
    for (const field of emailRuleFields('gmail')) expect(field.read(linearIssue)).toEqual([]);
  });

  it('domain is not stops at the edge of the Item: never matches a Linear issue', () => {
    const when = {
      join: 'and' as const,
      terms: [{ field: 'gmail.domain', op: 'is-not' as const, value: 'stripe.com', label: 'stripe.com' }],
    };
    expect(firstMatch([{ when }], linearIssue)).toBeUndefined();
  });

  it('is offered once, as Email, and tells email fields apart', () => {
    expect(RULE_SOURCES.find((each) => each.source === 'email')?.fields.map((field) => field.id)).toEqual([
      'gmail.from',
      'gmail.domain',
      'gmail.to',
      'gmail.subject',
      'gmail.account',
      'gmail.list',
      'gmail.attachment',
      'gmail.label',
    ]);
    expect(isEmailRuleField('outlook.from')).toBe(true);
    expect(isEmailRuleField('linear.team')).toBe(false);
  });

  it('reads as a sentence', () => {
    expect(
      describeRule({
        join: 'and',
        terms: [
          { field: 'gmail.domain', op: 'is', value: 'stripe.com', label: 'stripe.com' },
          { field: 'gmail.attachment', op: 'is', value: 'yes', label: 'yes' },
        ],
      }),
    ).toBe('from domain is stripe.com AND has attachment is yes');
  });
});

describe('Bucket and Project Rules in one list', () => {
  const stamp = { createdAt: 0 };
  const rules: Rule[] = [
    rule.parse({
      id: 'r-domain-tx',
      target: { kind: 'project', projectId: 'tx' },
      when: {
        join: 'and',
        terms: [{ field: 'gmail.domain', op: 'is', value: 'stripe.com', label: 'stripe.com' }],
      },
      order: 0,
      ...stamp,
    }),
    rule.parse({
      id: 'r-receipts',
      target: { kind: 'bucket', bucketId: 'receipts' },
      when: {
        join: 'and',
        terms: [{ field: 'gmail.subject', op: 'contains', value: 'receipt', label: 'receipt' }],
      },
      order: 1,
      ...stamp,
    }),
    rule.parse({
      id: 'r-domain-junk',
      target: { kind: 'bucket', bucketId: 'junk' },
      when: {
        join: 'and',
        terms: [{ field: 'gmail.domain', op: 'is', value: 'stripe.com', label: 'stripe.com' }],
      },
      order: 2,
      ...stamp,
    }),
  ];

  it('the first match per kind of target wins', () => {
    const item = email('outlook');
    expect(firstMatchFor(rules, 'project', item)?.id).toBe('r-domain-tx');
    expect(firstMatchFor(rules, 'bucket', item)?.id).toBe('r-receipts');
    expect(firstMatchFor(rules, 'bucket', email('gmail', { subject: 'Hello' }))?.id).toBe('r-domain-junk');
  });
});
