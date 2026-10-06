import { describe, expect, it } from 'vitest';
import type { EmailDetail } from './email';
import {
  emailSearchMatches,
  emailSnoozeChoices,
  gmailSearchUrl,
  outlookSearchUrl,
  parseEmailSearch,
  threadActionFields,
  threadInView,
} from './email-actions';

// Organising email (#135): what each thread action changes on each message, which views a thread is
// in, Section search's operators, Gmail's own search link and the snooze choices.

const HOUR = 60 * 60_000;

function mail(id: string, fields: Partial<EmailDetail> = {}): { id: string; detail: EmailDetail } {
  return {
    id,
    detail: {
      kind: 'email',
      messageId: `<${id}@mail.test>`,
      inReplyTo: null,
      references: [],
      threadKey: 'mid:<t@mail.test>',
      sourceThreadId: 'g1',
      from: { name: 'Dana Whitfield', address: 'dana@northwind.test' },
      to: [{ name: 'Alex Kim', address: 'alex@gmail.test' }],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: 'Q4 offsite dates',
      sentAt: 1,
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
      ...fields,
    },
  };
}

describe('thread actions', () => {
  const thread = [mail('m1', { sentAt: 1 }), mail('m2', { sentAt: 2, read: false })];

  it('archives, trashes and moves back to the inbox every message', () => {
    expect(threadActionFields({ type: 'archive' }, thread)).toEqual([
      { itemId: 'm1', fields: { inbox: false } },
      { itemId: 'm2', fields: { inbox: false } },
    ]);
    expect(threadActionFields({ type: 'trash' }, thread)).toEqual([
      { itemId: 'm1', fields: { trash: true } },
      { itemId: 'm2', fields: { trash: true } },
    ]);
    const trashed = thread.map((each) => mail(each.id, { ...each.detail, inTrash: true }));
    expect(threadActionFields({ type: 'move-to-inbox' }, trashed)).toEqual([
      { itemId: 'm1', fields: { trash: false } },
      { itemId: 'm2', fields: { trash: false } },
    ]);
  });

  it('archiving a snoozed thread that came back clears its "Snoozed until"', () => {
    const back = [mail('m1', { snooze: { until: 9, returned: true } })];
    expect(threadActionFields({ type: 'archive' }, back)).toEqual([
      { itemId: 'm1', fields: { inbox: false, snooze: null } },
    ]);
  });

  it('trashing a snoozed thread unsnoozes it, so it never comes back from Trash', () => {
    const snoozed = [mail('m1', { snooze: { until: 9, returned: false } })];
    expect(threadActionFields({ type: 'trash' }, snoozed)).toEqual([
      { itemId: 'm1', fields: { trash: true, snooze: null } },
    ]);
  });

  it('marks read or unread only the messages that need it', () => {
    expect(threadActionFields({ type: 'read' }, thread)).toEqual([{ itemId: 'm2', fields: { read: true } }]);
    expect(threadActionFields({ type: 'unread' }, thread)).toEqual([
      { itemId: 'm1', fields: { read: false } },
    ]);
  });

  it('stars the latest message, as Gmail does, and unstars every starred one', () => {
    expect(threadActionFields({ type: 'star' }, thread)).toEqual([
      { itemId: 'm2', fields: { starred: true } },
    ]);
    const starred = [mail('m1', { starred: true }), mail('m2', { sentAt: 2, starred: true })];
    expect(threadActionFields({ type: 'unstar' }, starred)).toEqual([
      { itemId: 'm1', fields: { starred: false } },
      { itemId: 'm2', fields: { starred: false } },
    ]);
  });

  it('adds and removes a label on every message', () => {
    const receipts = { id: 'Label_1', name: 'Receipts' };
    expect(threadActionFields({ type: 'label', label: receipts }, thread)).toEqual([
      { itemId: 'm1', fields: { 'label:Label_1': receipts } },
      { itemId: 'm2', fields: { 'label:Label_1': receipts } },
    ]);
    const labelled = [mail('m1', { labels: [receipts] })];
    expect(threadActionFields({ type: 'unlabel', labelId: 'Label_1' }, labelled)).toEqual([
      { itemId: 'm1', fields: { 'label:Label_1': null } },
    ]);
  });

  it('snoozes every message, and unsnoozes them', () => {
    expect(threadActionFields({ type: 'snooze', until: 9 * HOUR }, thread)).toEqual([
      { itemId: 'm1', fields: { snooze: { until: 9 * HOUR, returned: false } } },
      { itemId: 'm2', fields: { snooze: { until: 9 * HOUR, returned: false } } },
    ]);
    const snoozed = [mail('m1', { snooze: { until: 9, returned: false } })];
    expect(threadActionFields({ type: 'unsnooze' }, snoozed)).toEqual([
      { itemId: 'm1', fields: { snooze: null } },
    ]);
  });
});

describe('views', () => {
  const now = 100;
  const details = (...list: Partial<EmailDetail>[]) => list.map((fields, n) => mail(`m${n}`, fields).detail);

  it('puts a thread with mail in the inbox in Inbox, and one with none in Archive', () => {
    expect(threadInView(details({}, { inInbox: false }), 'inbox', now)).toBe(true);
    expect(threadInView(details({ inInbox: false }), 'inbox', now)).toBe(false);
    expect(threadInView(details({ inInbox: false }), 'archive', now)).toBe(true);
    expect(threadInView(details({}), 'archive', now)).toBe(false);
  });

  it('takes a trashed thread out of every view but Trash', () => {
    const trashed = details({ inTrash: true, starred: true, labels: [{ id: 'Label_1', name: 'Receipts' }] });
    for (const view of ['inbox', 'archive', 'starred', 'label:Label_1', 'snoozed'] as const)
      expect(threadInView(trashed, view, now)).toBe(false);
    expect(threadInView(trashed, 'trash', now)).toBe(true);
  });

  it('keeps a snoozed thread in Snoozed until its time, out of the inbox', () => {
    const snoozed = details({ snooze: { until: 200, returned: false } });
    expect(threadInView(snoozed, 'snoozed', now)).toBe(true);
    expect(threadInView(snoozed, 'inbox', now)).toBe(false);
    expect(threadInView(snoozed, 'archive', now)).toBe(false);
    expect(threadInView(snoozed, 'snoozed', 300)).toBe(false);
    // New mail in the thread brings it back, as in Gmail.
    expect(threadInView([...snoozed, mail('new').detail], 'inbox', now)).toBe(true);
  });

  it('lists starred threads and each label’s', () => {
    const starred = details({ starred: true, inInbox: false, labels: [{ id: 'Label_1', name: 'Receipts' }] });
    expect(threadInView(starred, 'starred', now)).toBe(true);
    expect(threadInView(starred, 'label:Label_1', now)).toBe(true);
    expect(threadInView(starred, 'label:Label_2', now)).toBe(false);
  });
});

describe('Section search', () => {
  it('reads from:, to:, subject:, has:attachment, is:unread and in:<view>, leaving the words', () => {
    expect(
      parseEmailSearch(
        'offsite from:dana to:alex subject:"q4 dates" has:attachment is:unread in:archive venue',
      ),
    ).toEqual({
      words: 'offsite venue',
      from: ['dana'],
      to: ['alex'],
      subject: ['q4 dates'],
      hasAttachment: true,
      unread: true,
      view: 'archive',
      label: null,
    });
    expect(parseEmailSearch('in:receipts').label).toBe('receipts');
    expect(parseEmailSearch('in:Trash').view).toBe('trash');
  });

  it('matches a message against the operators', () => {
    const query = parseEmailSearch('from:dana subject:offsite is:unread');
    expect(emailSearchMatches(mail('m1', { read: false }).detail, query)).toBe(true);
    expect(emailSearchMatches(mail('m1', { read: true }).detail, query)).toBe(false);
    expect(emailSearchMatches(mail('m1', { read: false }).detail, parseEmailSearch('to:priya'))).toBe(false);
    expect(emailSearchMatches(mail('m1').detail, parseEmailSearch('has:attachment'))).toBe(false);
  });

  it('opens Gmail’s own search for the same words in the Account', () => {
    expect(gmailSearchUrl('alex@gmail.test', 'offsite from:dana in:archive')).toBe(
      'https://mail.google.com/mail/?authuser=alex%40gmail.test#search/offsite%20from%3Adana%20-in%3Ainbox',
    );
    expect(gmailSearchUrl('alex@gmail.test', 'in:receipts venue')).toBe(
      'https://mail.google.com/mail/?authuser=alex%40gmail.test#search/label%3Areceipts%20venue',
    );
  });
});

describe('snooze choices', () => {
  it('offers later today, tomorrow morning, this weekend and next week, in local time', () => {
    // Wednesday 7 October 2026, 10:15.
    const now = new Date(2026, 9, 7, 10, 15).getTime();
    expect(
      emailSnoozeChoices(now).map((choice) => [choice.label, new Date(choice.until).toString()]),
    ).toEqual([
      ['Later today', new Date(2026, 9, 7, 18).toString()],
      ['Tomorrow morning', new Date(2026, 9, 8, 8).toString()],
      ['This weekend', new Date(2026, 9, 10, 8).toString()],
      ['Next week', new Date(2026, 9, 12, 8).toString()],
    ]);
  });

  it('leaves out later today in the evening, and this weekend at the weekend', () => {
    const saturdayEvening = new Date(2026, 9, 10, 19).getTime();
    expect(emailSnoozeChoices(saturdayEvening).map((choice) => choice.label)).toEqual([
      'Tomorrow morning',
      'Next week',
    ]);
  });
});

describe('Outlook threads (#136)', () => {
  const inbox = { id: 'AAMk-folder-inbox', name: 'Inbox', wellKnown: 'inbox' };
  const sent = { id: 'AAMk-folder-sent', name: 'Sent Items', wellKnown: 'sentitems' };
  const projects = { id: 'AAMk-folder-projects', name: 'Projects' };
  const thread = [
    mail('m1', { sentAt: 1, folder: inbox, labels: [] }),
    mail('m2', { sentAt: 2, folder: sent, labels: [], inInbox: false, sentByMe: true }),
    mail('m3', { sentAt: 3, folder: inbox, labels: [], inTrash: true }),
  ];

  it('moves every message to a folder, leaving the User’s own in Sent Items', () => {
    const folder = { ...projects, wellKnown: null };
    expect(threadActionFields({ type: 'move', folder: projects }, thread)).toEqual([
      { itemId: 'm1', fields: { folder, inbox: false } },
      { itemId: 'm3', fields: { folder, inbox: false, trash: false } },
    ]);
    // Already there: nothing to change.
    const filed = [mail('m4', { folder, inInbox: false, labels: [] })];
    expect(threadActionFields({ type: 'move', folder: projects }, filed)).toEqual([]);
  });

  it('moves to the Inbox as into the inbox', () => {
    expect(
      threadActionFields({ type: 'move', folder: inbox }, [mail('m5', { folder, inInbox: false })]),
    ).toEqual([{ itemId: 'm5', fields: { folder: inbox, inbox: true } }]);
  });

  it('opens Outlook on the web’s search for the Account', () => {
    expect(outlookSearchUrl('sam@contoso.test', 'offsite from:dana', false)).toBe(
      'https://outlook.office.com/mail/deeplink/search?query=offsite%20from%3Adana&login_hint=sam%40contoso.test',
    );
    expect(outlookSearchUrl('sam@outlook.test', 'in:archive venue', true)).toBe(
      'https://outlook.live.com/mail/deeplink/search?query=venue&login_hint=sam%40outlook.test',
    );
  });
});

const folder = { id: 'AAMk-folder-projects', name: 'Projects', wellKnown: null };
