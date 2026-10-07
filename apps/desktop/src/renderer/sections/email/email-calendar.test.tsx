// @vitest-environment jsdom
import type {
  AresActivity,
  EmailDetail,
  EmailInvitationCard,
  EventDetail,
  Item,
  ItemAction,
} from '@commander/domain';
import { Toaster } from '@commander/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemChanges } from '../../item-store/changes';
import type { ItemStoreClient } from '../../item-store/client';
import type { AutonomyClient } from '../ares/activity';
import { AresOnThread } from './AresOnThread';
import type { EmailClient } from './email';
import { InvitationCard } from './InvitationCard';

// Email meets Calendar and Todos in the window (#144): the Invitation card above an invitation email
// (its event, a clash mark, Accept, Maybe and Decline answering the event as from Calendar, and Open in
// Gmail when Commander can't show it), and Ares's suggestions on a thread (a Todo with Add and Dismiss;
// a proposed event with its cause, Create and Dismiss, and Reply with your booking link only for an
// outsider). The Core is stood in for. Times are local, so they read the same in any time zone.

const NOW = new Date(2026, 9, 6, 10, 42).getTime();
const THURSDAY_3PM = new Date(2026, 9, 8, 15).getTime();
const HOUR = 3_600_000;
const BOOKING = 'https://calendar.app.google/alex';
const noChanges: ItemChanges = () => () => {};

const emailDetail = (fields: Partial<EmailDetail> = {}): EmailDetail => ({
  kind: 'email',
  messageId: '<m@mail.test>',
  inReplyTo: null,
  references: [],
  threadKey: 'mid:<m@mail.test>',
  sourceThreadId: null,
  from: { name: 'Dana Reyes', address: 'dana@acme.test' },
  to: [{ name: null, address: 'alex@gmail.test' }],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: 'Invitation: Pricing review',
  sentAt: new Date(2026, 9, 6, 9, 42).getTime(),
  snippet: '',
  read: true,
  starred: false,
  inInbox: true,
  sentByMe: false,
  labels: [],
  attachments: [],
  hasInvitation: false,
  listUnsubscribe: null,
  listId: null,
  ...fields,
});

const item = (id: string, kind: Item['kind'], detail: Item['detail'], fields: Partial<Item> = {}): Item => ({
  id,
  kind,
  source: kind === 'email' ? 'gmail' : 'google-calendar',
  account: 'google:alex',
  externalId: `ext-${id}`,
  title: id,
  people: [],
  filing: null,
  status: 'open',
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  detail,
  ...fields,
});

const eventDetail: EventDetail = {
  kind: 'event',
  calendar: { id: 'alex@gmail.test', name: 'alex@gmail.test', colour: '#9fe1e7' },
  accountEmail: 'alex@gmail.test',
  start: { at: THURSDAY_3PM, timeZone: null, date: null },
  end: { at: THURSDAY_3PM + HOUR, timeZone: null, date: null },
  allDay: false,
  location: null,
  description: null,
  organiser: { email: 'dana@acme.test', name: 'Dana Reyes', self: false },
  attendees: [],
  myResponse: 'needs-action',
  meetingUrl: null,
  busy: true,
  private: false,
  seriesId: null,
  webUrl: null,
  createdByCommander: null,
};

const invitation = item('invite', 'email', emailDetail({ hasInvitation: true }), {
  title: 'Invitation: Pricing review',
});
const pricing = item('pricing', 'event', eventDetail, { title: 'Pricing review' });

let card: EmailInvitationCard;
let answered: { eventId: string; fields: unknown }[];

function emailClient(): EmailClient {
  return {
    invitation: async () => card,
    answerInvitation: async (eventId, fields) => {
      answered.push({ eventId, fields });
      return { id: 41 } as never;
    },
    outgoing: async () => [],
    retry: async () => {},
    undo: async () => {},
  } as Partial<EmailClient> as EmailClient;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  answered = [];
  card = { state: 'event', event: pricing, clashes: [] };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the Invitation card', () => {
  it('shows the event in the User’s zone, and Accept answers it as from Calendar', async () => {
    card = {
      state: 'event',
      event: pricing,
      clashes: [{ id: 'board', title: 'Board prep', account: 'microsoft:alex' }],
    };
    render(
      <>
        <InvitationCard
          email={invitation}
          client={emailClient()}
          changes={noChanges}
          address="alex@gmail.test"
        />
        <Toaster />
      </>,
    );
    const region = await screen.findByRole('region', { name: 'Invitation' });
    await waitFor(() => expect(region.getAttribute('data-state')).toBe('event'));
    expect(within(region).getByTestId('invitation-title').textContent).toContain('Pricing review');
    expect(within(region).getByTestId('invitation-when').textContent).toContain('Thu 8 Oct 15:00–16:00');
    expect(within(region).getByTestId('invitation-clash').textContent).toContain(
      'Clashes with “Board prep” in another Account',
    );
    const answers = within(region).getByRole('group', { name: 'Answer this invitation' });
    fireEvent.click(within(answers).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(answered).toEqual([{ eventId: 'pricing', fields: { response: 'accepted' } }]));
  });

  it('offers Open in Gmail when its calendar isn’t synced', async () => {
    card = {
      state: 'unsynced',
      why: 'no-calendar',
      title: 'Pricing review',
      start: THURSDAY_3PM,
      end: THURSDAY_3PM + HOUR,
      allDay: false,
    };
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(
      <InvitationCard
        email={invitation}
        client={emailClient()}
        changes={noChanges}
        address="alex@gmail.test"
      />,
    );
    expect((await screen.findByTestId('invitation-unsynced')).textContent).toContain(
      'This invitation is for a calendar Commander doesn’t sync.',
    );
    fireEvent.click(screen.getByRole('button', { name: /Open in Gmail/ }));
    expect(open).toHaveBeenCalledWith(
      'https://mail.google.com/mail/?authuser=alex%40gmail.test#all/ext-invite',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('shows nothing for a cancellation', async () => {
    card = { state: 'none' };
    const cancelled = item('cancel', 'email', emailDetail({ hasInvitation: true }), {});
    render(<InvitationCard email={cancelled} client={emailClient()} changes={noChanges} address={null} />);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Invitation' })).toBeNull());
  });
});

// Ares's suggestions on a thread, as the gate keeps them.
function row(
  id: number,
  itemId: string,
  action: string,
  itemActions: ItemAction[] | unknown[],
  reason: string,
) {
  return {
    id,
    itemId,
    action,
    actionKind: action === 'suggest-todos' ? 'organise' : 'act-for-you',
    section: action === 'suggest-todos' ? 'email' : 'calendar',
    itemActions,
    confidence: 0.6,
    reason,
    at: NOW,
    causedBy: { itemId },
    chained: action !== 'suggest-todos',
    decision: 'ask',
    status: 'pending',
    settledAt: null,
    entryIds: [],
    name: action,
    item: { id: itemId, kind: 'email', title: 'Pricing call', source: 'gmail', deletedAt: null },
    cause: null,
    undoable: false,
  } as unknown as AresActivity;
}

const todoRow = row(
  7,
  'q3',
  'suggest-todos',
  [
    {
      type: 'create',
      item: {
        kind: 'todo',
        title: 'Send Dana the Q3 numbers',
        detail: { kind: 'todo', origin: 'ares', dueOn: '2026-10-09', backedBy: null },
      },
    },
    { type: 'link', from: { step: 0 }, linkType: 'made-from', to: 'q3' },
  ],
  'Dana Reyes asked in “Q3 numbers”',
);
const eventRow = row(
  8,
  'call',
  'create-events-with-guests',
  [
    {
      type: 'create-event',
      event: {
        kind: 'meeting',
        account: 'google:alex',
        calendarId: 'alex@gmail.test',
        title: 'Call with Dana',
        start: { at: THURSDAY_3PM, timeZone: 'Europe/London', date: null },
        end: { at: THURSDAY_3PM + HOUR / 2, timeZone: 'Europe/London', date: null },
        attendees: [{ email: 'dana@acme.test', name: 'Dana Reyes' }],
        guestsToFill: [],
      },
    },
    { type: 'link', from: { step: 0 }, linkType: 'made-from', to: 'call' },
  ],
  'Dana wrote “How about Thursday at 3?”. You’re free then.',
);

function threadOf(sender: string) {
  return [
    {
      item: item(
        'q3',
        'email',
        emailDetail({ subject: 'Q3 numbers', from: { name: 'Dana Reyes', address: sender } }),
      ),
      body: { text: 'Can you send me the Q3 numbers by Friday?' },
    },
    {
      item: item(
        'call',
        'email',
        emailDetail({ subject: 'Pricing call', from: { name: 'Dana Reyes', address: sender } }),
      ),
      body: { text: 'How about Thursday at 3?' },
    },
  ];
}

function renderThread(sender: string) {
  const settled: { op: string; proposalId: number }[] = [];
  const autonomy = (async (request: { op: string; proposalId?: number; query?: { section?: string } }) => {
    if (request.op === 'activity')
      return [todoRow, eventRow].filter((each) => each.section === request.query?.section);
    settled.push({ op: request.op, proposalId: request.proposalId as number });
    return { entryIds: [] };
  }) as unknown as AutonomyClient;
  const itemStore = (async (request: { op: string }) => {
    if (request.op === 'scheduling-settings')
      return { newEventsAccount: null, newEventsCalendar: null, bookingLink: BOOKING };
    if (request.op === 'focus-settings') return { focusAccount: null };
    return [];
  }) as unknown as ItemStoreClient;
  const replies: { emailId: string; text: string; link: string }[] = [];
  render(
    <>
      <AresOnThread
        messages={threadOf(sender)}
        autonomy={autonomy}
        itemStore={itemStore}
        changes={noChanges}
        accountAddresses={['alex@acme.test']}
        onReplyWithBookingLink={(emailId, text, link) => replies.push({ emailId, text, link })}
      />
      <Toaster />
    </>,
  );
  return { settled, replies };
}

describe('Ares on a thread', () => {
  it('a suggested Todo: its title, due day and reason, with Add accepting it', async () => {
    const { settled } = renderThread('dana@contoso.test');
    const todo = await screen.findByTestId('email-todo-suggestion');
    expect(todo.textContent).toContain('Ares suggests a Todo · Send Dana the Q3 numbers · due Fri 9 Oct');
    expect(todo.textContent).toContain('Dana Reyes asked in “Q3 numbers”');
    fireEvent.click(within(todo).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(settled).toEqual([{ op: 'accept', proposalId: 7 }]));
  });

  it('a proposed event shows its cause; an outsider gets Reply with your booking link', async () => {
    const { settled, replies } = renderThread('dana@contoso.test');
    const proposal = await screen.findByTestId('email-event-proposal');
    expect(within(proposal).getByTestId('email-event-cause').textContent).toContain(
      'Suggested because of Dana’s email, 09:42',
    );
    expect(within(proposal).getByTestId('meeting-headline').textContent).toContain(
      'Call with Dana · 30 min · Thu 8 Oct 15:00',
    );
    // The card's own copy button is never offered here: the reply is.
    expect(within(proposal).queryByRole('button', { name: 'Send your booking link instead' })).toBeNull();
    fireEvent.click(await within(proposal).findByRole('button', { name: 'Reply with your booking link' }));
    expect(replies).toEqual([{ emailId: 'call', text: `Book a time here: ${BOOKING}`, link: BOOKING }]);
    fireEvent.click(within(proposal).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(settled).toContainEqual({ op: 'accept', proposalId: 8 }));
  });

  it('a colleague (the User’s own organisation) gets no booking link', async () => {
    renderThread('dana@acme.test');
    const proposal = await screen.findByTestId('email-event-proposal');
    await waitFor(() =>
      expect(within(proposal).getByTestId('meeting-status').textContent).toContain('15:00'),
    );
    expect(within(proposal).queryByRole('button', { name: 'Reply with your booking link' })).toBeNull();
  });
});
