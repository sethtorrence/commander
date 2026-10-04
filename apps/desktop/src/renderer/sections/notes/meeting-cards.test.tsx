// @vitest-environment jsdom
import type { Gate } from '@commander/core/src/autonomy/gate';
import type { ItemStore } from '@commander/core/src/item-store';
import { answerItemStoreRequest } from '@commander/core/src/item-store-requests';
import {
  type AccountSyncStatus,
  type GoogleAccountSummary,
  type Proposal,
  type SourceItem,
  zonedTime,
} from '@commander/domain';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemStoreClient } from '../../item-store/client';
import type { AutonomyClient } from '../ares/activity';
import { openTestGate } from '../ares/test-gate';
import { type MeetingProposal, meetingProposalOf, useMeetingProposals } from '../calendar/meetings';
import type { Scheduling } from '../calendar/use-scheduling';
import { MeetingMarginCard } from './MeetingMarginCard';

// Ares's proposed meeting (#132) as its margin card, on a real gate and Item store on a temporary
// database, reached as the window reaches them: the event, its time and whether the User is free;
// Create (with what the User filled in), Other times, Edit in Google Calendar (pre-filled), Dismiss,
// and Send your booking link instead for a guest outside the User's organisations.

const LONDON = 'Europe/London';
const ALEX = 'google:104512345678901234567';
const PRIMARY = 'alex@gmail.test';
const START = zonedTime('2026-10-06', '14:00', LONDON);
const HALF = 30 * 60_000;

let store: ItemStore;
let gate: Gate;
let autonomy: AutonomyClient;
let itemStore: ItemStoreClient;
let close: () => void;
let block: string;
let listeners: (() => void)[];

const onAresActivity = (listener: () => void) => {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((other) => other !== listener);
  };
};

const sync = (): AccountSyncStatus => ({
  account: ALEX,
  source: 'google-calendar',
  activity: 'idle',
  cadenceMinutes: 15,
  cadenceChoices: [15, 30, 60],
  lastSyncedAt: 0,
  nextSyncAt: null,
  itemCount: 0,
  problem: null,
  outgoing: { pending: 0, failed: 0 },
});
const alex: GoogleAccountSummary = {
  id: ALEX,
  source: 'google',
  name: `Google · ${PRIMARY}`,
  email: PRIMARY,
  method: 'oauth',
  status: 'connected',
  user: { id: '104512345678901234567', name: 'Alex Kim' },
  sync: sync(),
  sources: [{ source: 'google-calendar', granted: true, enabled: true, sync: sync() }],
};

const meeting = (guestsToFill: string[] = ['Omar']): Proposal => ({
  actionKind: 'act-for-you',
  action: 'create-events-with-guests',
  section: 'calendar',
  itemId: block,
  itemActions: [
    {
      type: 'create-event',
      event: {
        kind: 'meeting',
        account: ALEX,
        calendarId: PRIMARY,
        title: 'Call with Leo',
        start: { at: START, timeZone: LONDON, date: null },
        end: { at: START + HALF, timeZone: LONDON, date: null },
        attendees: [{ email: 'leo.park@acme.test', name: 'Leo Park' }],
        guestsToFill,
      },
    },
    { type: 'link', from: { step: 0 }, linkType: 'made-from', to: block },
  ],
  confidence: 0.9,
  reason: 'You wrote “call with Leo and Omar Tuesday at 2” in your Daily Note. You’re free then.',
});

function Harness({ scheduling }: { scheduling: Scheduling }) {
  const proposals = useMeetingProposals(autonomy, onAresActivity, true);
  return (
    <>
      {[...proposals.byBlock.values()].flat().map((proposal: MeetingProposal) => (
        <MeetingMarginCard
          key={proposal.id}
          day="2026-10-03"
          proposal={proposal}
          scheduling={scheduling}
          itemStore={itemStore}
          onCreate={(chosen, draft) => void proposals.create(chosen, draft)}
          onDismiss={(id) => void proposals.dismiss(id)}
        />
      ))}
    </>
  );
}

const scheduling = (bookingLink: string | null = null): Scheduling => ({
  accounts: [alex],
  calendars: store.calendars.list(),
  bookingLink,
  newEvents: { account: ALEX, calendarId: PRIMARY },
});

beforeEach(() => {
  ({ store, gate, client: autonomy, close } = openTestGate());
  listeners = [];
  let id = 0;
  itemStore = (async (request) => {
    id += 1;
    // Find time is the scheduler's, answered once the providers have: here, two free times.
    if (request.op === 'find-time') {
      return {
        slots: [
          { start: START + 4 * HALF, end: START + 5 * HALF },
          { start: START + 24 * 2 * HALF, end: START + 24 * 2 * HALF + HALF },
        ],
        timeZone: LONDON,
        guests: [
          {
            email: 'leo.park@acme.test',
            checked: false,
            why: 'Outside your organisations: only your calendars were checked.',
            outside: true,
          },
        ],
        bookingLink: null,
      };
    }
    const reply = answerItemStoreRequest(store, { type: 'item-store-request', id, request });
    if (!reply?.response.ok)
      throw new Error(reply?.response.ok === false ? reply.response.error : 'No reply');
    return reply.response.result;
  }) as ItemStoreClient;
  gate.registerAction({
    action: 'create-events-with-guests',
    actionKind: 'act-for-you',
    name: 'Create events with guests',
  });
  gate.registerAction({
    action: 'hold-time-for-yourself',
    actionKind: 'tidy-sources',
    name: 'Hold time for yourself',
  });
  store.calendars.listed(ALEX, 'google-calendar', [
    { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7', primary: true, accessRole: 'owner' },
  ]);
  const note = store.ensureDailyNote('2026-10-03', { by: { kind: 'user' } }).id;
  const text = 'call with Leo and Omar Tuesday at 2';
  block = store.record(
    {
      type: 'create',
      item: {
        kind: 'block',
        title: text,
        detail: { kind: 'block', dailyNoteId: note, parentId: null, position: 'a0', text, folded: false },
      },
    },
    { by: { kind: 'user' } },
  ).itemId;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  close();
});

const card = () => screen.getByRole('group', { name: 'Event suggested by Ares: Call with Leo' });

describe('a proposed meeting’s card', () => {
  it('reads the suggestion as the meeting it would make', () => {
    const outcome = gate.propose(meeting());
    if (outcome.decision !== 'ask') throw new Error('Wanted a suggestion');
    const [row] = gate.activity({ statuses: ['pending'] });
    expect(meetingProposalOf(row as never)).toMatchObject({
      blockId: block,
      draft: {
        title: 'Call with Leo',
        start: START,
        end: START + HALF,
        account: ALEX,
        calendarId: PRIMARY,
        guests: [{ email: 'leo.park@acme.test', name: 'Leo Park' }],
        toFill: ['Omar'],
        timeZone: LONDON,
      },
    });
  });

  it('shows the event, its time and that the User is free; Create, with Omar filled in, makes it with both invited', async () => {
    gate.propose(meeting());
    render(<Harness scheduling={scheduling()} />);
    await waitFor(() => expect(card()).toBeTruthy());
    expect(within(card()).getByTestId('meeting-headline').textContent).toBe(
      'Call with Leo · 30 min · Tue 6 Oct 14:00',
    );
    await waitFor(() =>
      expect(within(card()).getByTestId('meeting-status').textContent).toBe('Tue 6 Oct 14:00, you’re free'),
    );
    fireEvent.change(within(card()).getByRole('textbox', { name: 'Omar’s email address' }), {
      target: { value: 'omar@titanlink.test' },
    });
    fireEvent.click(within(card()).getByRole('button', { name: 'Add' }));
    fireEvent.click(within(card()).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(store.query({ kinds: ['event'] })).toHaveLength(1));
    const [event] = store.query({ kinds: ['event'] });
    expect(event?.detail).toMatchObject({
      createdByCommander: 'meeting',
      attendees: [{ email: 'leo.park@acme.test' }, { email: 'omar@titanlink.test' }],
    });
    expect(store.get(event?.id as string)?.links).toMatchObject([{ type: 'made-from', to: { id: block } }]);
    // Queued for Google Calendar with the guests to invite.
    expect(store.outgoing.forItem(event?.id as string)).toMatchObject([
      {
        field: 'create',
        value: {
          kind: 'meeting',
          attendees: [{ email: 'leo.park@acme.test' }, { email: 'omar@titanlink.test' }],
        },
      },
    ]);
    await waitFor(() => expect(screen.queryByTestId('meeting-card')).toBeNull());
  });

  it('says what the time clashes with', async () => {
    const clash: SourceItem = {
      externalId: `${PRIMARY}/board`,
      kind: 'event',
      title: 'Board prep',
      detail: {
        kind: 'event',
        calendar: { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7' },
        accountEmail: PRIMARY,
        start: { at: START - HALF, timeZone: LONDON, date: null },
        end: { at: START + HALF, timeZone: LONDON, date: null },
        allDay: false,
        location: null,
        description: null,
        organiser: null,
        attendees: [],
        myResponse: null,
        meetingUrl: null,
        busy: true,
        private: false,
        seriesId: null,
        webUrl: null,
        createdByCommander: null,
      },
    };
    store.saveFromSource({ source: 'google-calendar', account: ALEX, items: [clash] });
    gate.propose(meeting([]));
    render(<Harness scheduling={scheduling()} />);
    await waitFor(() =>
      expect(within(card()).getByTestId('meeting-status').textContent).toBe(
        'Tue 6 Oct 14:00, clashes with Board prep',
      ),
    );
  });

  it('hands off to Google Calendar’s own editor, pre-filled, and puts the suggestion away', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    gate.propose(meeting([]));
    render(<Harness scheduling={scheduling()} />);
    await waitFor(() => expect(card()).toBeTruthy());
    fireEvent.click(within(card()).getByRole('button', { name: /Edit in Google Calendar/ }));
    const url = new URL(String(open.mock.calls[0]?.[0]));
    expect(`${url.origin}${url.pathname}`).toBe('https://calendar.google.com/calendar/r/eventedit');
    expect(url.searchParams.get('text')).toBe('Call with Leo');
    expect(url.searchParams.get('add')).toBe('leo.park@acme.test');
    expect(url.searchParams.get('authuser')).toBe(PRIMARY);
    await waitFor(() => expect(gate.activity({ statuses: ['dismissed'] })).toHaveLength(1));
    expect(store.query({ kinds: ['event'] })).toEqual([]);
  });

  it('Other times offers free times (saying whose calendars couldn’t be checked), and picking one moves it', async () => {
    gate.propose(meeting([]));
    render(<Harness scheduling={scheduling()} />);
    await waitFor(() => expect(card()).toBeTruthy());
    fireEvent.click(within(card()).getByRole('button', { name: 'Other times' }));
    const times = await within(card()).findByRole('list', { name: 'Other times' });
    expect(within(card()).getByTestId('other-times').textContent).toContain(
      'leo.park@acme.test: Outside your organisations: only your calendars were checked.',
    );
    fireEvent.click(within(times).getByRole('button', { name: 'Tue 6 Oct 16:00' }));
    expect(within(card()).getByTestId('meeting-headline').textContent).toBe(
      'Call with Leo · 30 min · Tue 6 Oct 16:00',
    );
    fireEvent.click(within(card()).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(store.query({ kinds: ['event'] })).toHaveLength(1));
    expect(store.query({ kinds: ['event'] })[0]?.detail).toMatchObject({ start: { at: START + 4 * HALF } });
  });

  it('Dismiss puts it away for good', async () => {
    gate.propose(meeting([]));
    render(<Harness scheduling={scheduling()} />);
    await waitFor(() => expect(card()).toBeTruthy());
    fireEvent.click(within(card()).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(gate.activity({ statuses: ['dismissed'] })).toHaveLength(1));
  });

  it('with a booking link saved, offers it for a guest outside the User’s organisations, copying the text', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    gate.propose(meeting([]));
    const { rerender } = render(<Harness scheduling={scheduling()} />);
    await waitFor(() => expect(card()).toBeTruthy());
    expect(within(card()).queryByRole('button', { name: 'Send your booking link instead' })).toBeNull();
    rerender(<Harness scheduling={scheduling('https://calendar.app.google/abc123')} />);
    fireEvent.click(within(card()).getByRole('button', { name: 'Send your booking link instead' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('Book a time here: https://calendar.app.google/abc123'),
    );
  });
});
