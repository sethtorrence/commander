// @vitest-environment jsdom
import { type Gate, openGate } from '@commander/core/src/autonomy/gate';
import { answerAutonomyRequest } from '@commander/core/src/autonomy/requests';
import type { ItemStore } from '@commander/core/src/item-store';
import { type EventDetail, REPLY_TO_INVITATIONS, type SourceItem } from '@commander/domain';
import type { AccountSyncStatus, GoogleAccountSummary } from '@commander/domain/ipc';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openTestItemStore } from '../../item-store/test-item-store';
import { ProjectsProvider } from '../../projects/context';
import { projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes } from '../../shortcuts/react';
import type { AutonomyClient } from '../ares/activity';
import { FrameControlsProvider, SectionProvider } from '../section';
import { calendar as definition } from '.';
import { CalendarSheet } from './CalendarSheet';
import { type CalendarAccountsClient, calendarEventsIn } from './calendar-events';
import { type InvitationsClient, invitationsIn } from './invitations';

// Answering invitations in the Calendar Section (#129), against a real Item store and gate on a
// temporary database, with events saved the way Google Calendar sync saves them, a fixed clock and
// the London time zone.

const ALEX = 'google:104512345678901234567';
const PRIMARY = 'alex@gmail.test';
const LONDON = 'Europe/London';
// Monday 5 October 2026, 10:30 in London.
const NOW = Date.UTC(2026, 9, 5, 9, 30);

let store: ItemStore;
let gate: Gate;
let invitations: InvitationsClient;
let close: () => void;
let projects: ReturnType<typeof projectsIn>;
let events: ReturnType<typeof calendarEventsIn>;
let aresListeners: Set<() => void>;
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };

const dana = { email: 'dana@titanlink.test', name: 'Dana Ruiz', self: false };
function invitation(id: string, title: string, start: string, end: string, extra: Partial<EventDetail> = {}) {
  const detail: EventDetail = {
    kind: 'event',
    calendar: { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7' },
    accountEmail: PRIMARY,
    start: { at: Date.parse(start), timeZone: LONDON, date: null },
    end: { at: Date.parse(end), timeZone: LONDON, date: null },
    allDay: false,
    location: null,
    description: null,
    organiser: dana,
    attendees: [
      { ...dana, response: 'accepted', organiser: true, optional: false, resource: false },
      {
        email: PRIMARY,
        name: null,
        self: true,
        response: 'needs-action',
        organiser: false,
        optional: false,
        resource: false,
      },
    ],
    myResponse: 'needs-action',
    meetingUrl: null,
    busy: true,
    private: false,
    seriesId: null,
    webUrl: null,
    createdByCommander: null,
    ...extra,
  };
  return { externalId: `${PRIMARY}/${id}`, kind: 'event', title, detail } satisfies SourceItem;
}

const sync = (overrides: Partial<AccountSyncStatus> = {}): AccountSyncStatus => ({
  account: ALEX,
  source: 'google-calendar',
  activity: 'idle',
  cadenceMinutes: 15,
  cadenceChoices: [15, 30, 60],
  lastSyncedAt: NOW,
  nextSyncAt: null,
  itemCount: 3,
  problem: null,
  outgoing: { pending: 0, failed: 0 },
  ...overrides,
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
const accounts: CalendarAccountsClient = {
  list: async () => [alex],
  refresh: async () => {},
  onChange: () => () => {},
};

let ids: Record<string, string>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const opened = openTestItemStore(() => NOW);
  ({ store, close } = opened);
  events = calendarEventsIn(opened.client);
  projects = projectsIn(opened.client);
  gate = openGate({
    itemStore: store,
    onChange: () =>
      queueMicrotask(() => {
        for (const each of aresListeners) each();
      }),
  });
  gate.registerAction({
    action: REPLY_TO_INVITATIONS,
    actionKind: 'act-for-you',
    name: 'Reply to invitations',
  });
  aresListeners = new Set();
  let id = 0;
  const autonomy: AutonomyClient = async (request) => {
    id += 1;
    const reply = answerAutonomyRequest(
      gate,
      { type: 'autonomy-request', id, request },
      { testHooks: false },
    );
    if (!reply?.response.ok)
      throw new Error(reply?.response.ok === false ? reply.response.error : 'No reply');
    // biome-ignore lint/suspicious/noExplicitAny: unchecked here, as the main process would check it
    return reply.response.result as any;
  };
  invitations = {
    ...invitationsIn({ itemStore: opened.client, autonomy }),
    onAresChange(listener) {
      aresListeners.add(listener);
      return () => aresListeners.delete(listener);
    },
  };
  localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  store.calendars.listed(ALEX, 'google-calendar', [
    { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7', primary: true, accessRole: 'owner' },
  ]);
  store.saveFromSource({
    source: 'google-calendar',
    account: ALEX,
    items: [
      invitation('pricing', 'Pricing review', '2026-10-05T13:00:00Z', '2026-10-05T14:00:00Z'),
      invitation('weekly', 'Weekly planning', '2026-10-05T15:00:00Z', '2026-10-05T16:00:00Z', {
        seriesId: 'weekly-series',
        myResponse: 'accepted',
      }),
      {
        ...invitation('mine', 'My focus time', '2026-10-05T11:00:00Z', '2026-10-05T12:00:00Z'),
        detail: {
          ...invitation('mine', '', '2026-10-05T11:00:00Z', '2026-10-05T12:00:00Z').detail,
          organiser: { email: PRIMARY, name: null, self: true },
          attendees: [],
          myResponse: null,
        },
      },
    ],
  });
  ids = Object.fromEntries(store.events({ from: 0, to: NOW * 2 }).map((item) => [item.title, item.id]));
});

afterEach(() => {
  cleanup();
  close();
  vi.useRealTimers();
});

function Active({ children }: { children: ReactNode }) {
  useActiveScopes(['calendar']);
  return children;
}

function renderSheet() {
  return render(
    <ShortcutProvider>
      <ProjectsProvider client={projects} storage={localStorage}>
        <FrameControlsProvider value={controls}>
          <SectionProvider place={{ definition, number: 6, total: 8, active: true }}>
            <ShortcutScope scope="calendar" group="Calendar">
              <Active>
                <CalendarSheet
                  events={events}
                  accounts={accounts}
                  invitations={invitations}
                  timeZone={LONDON}
                  open={() => {}}
                />
              </Active>
            </ShortcutScope>
          </SectionProvider>
        </FrameControlsProvider>
      </ProjectsProvider>
    </ShortcutProvider>,
  );
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(document.body, { key, ...init });
  });
const row = (title: string) =>
  screen
    .getAllByTestId('calendar-event')
    .find((each) => each.getAttribute('aria-label')?.endsWith(title)) as HTMLElement;
const answerOf = (title: string) =>
  (store.get(ids[title] as string)?.item.detail as EventDetail | undefined)?.myResponse;
const pressed = (group: HTMLElement) =>
  within(group)
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.textContent?.replace(/[A-Z]$/, '').trim());
const pane = () => screen.getByRole('region', { name: 'Event detail' });

async function open(title: string) {
  await waitFor(() => expect(row(title)).toBeTruthy());
  fireEvent.click(row(title));
  await waitFor(() => expect(within(pane()).getByRole('heading', { name: title })).toBeTruthy());
}

describe('answering invitations', () => {
  it('offers Accept, Maybe and Decline on the rows of events the User is invited to, the current answer pressed', async () => {
    renderSheet();
    await waitFor(() => expect(row('Pricing review')).toBeTruthy());
    expect(
      pressed(within(row('Pricing review')).getByRole('group', { name: 'Answer Pricing review' })),
    ).toEqual([]);
    expect(pressed(within(row('Weekly planning')).getByRole('group'))).toEqual(['Accept']);
    // Their own event has nothing to answer.
    expect(within(row('My focus time')).queryByRole('group')).toBeNull();
  });

  it('answers at once from the row, queueing the answer for Google Calendar', async () => {
    renderSheet();
    await waitFor(() => expect(row('Pricing review')).toBeTruthy());
    fireEvent.click(within(row('Pricing review')).getByRole('button', { name: 'Maybe' }));
    await waitFor(() => expect(answerOf('Pricing review')).toBe('tentative'));
    await waitFor(() => expect(pressed(within(row('Pricing review')).getByRole('group'))).toEqual(['Maybe']));
    expect(store.outgoing.list()).toMatchObject([{ itemId: ids['Pricing review'], field: 'response' }]);
  });

  it('answers the selected invitation with Y, I and N, listed for the cheat sheet, and Ctrl+Z takes it back', async () => {
    renderSheet();
    await open('Pricing review');
    press('n');
    await waitFor(() => expect(answerOf('Pricing review')).toBe('declined'));
    await waitFor(() =>
      expect(within(pane()).getByRole('status').textContent).toBe('Saving to Google Calendar…'),
    );
    press('z', { ctrlKey: true });
    await waitFor(() => expect(answerOf('Pricing review')).toBe('needs-action'));
    press('y');
    await waitFor(() => expect(answerOf('Pricing review')).toBe('accepted'));
    press('i');
    await waitFor(() => expect(answerOf('Pricing review')).toBe('tentative'));
  });

  it('answers one instance of a series, or all of it, from the detail pane', async () => {
    renderSheet();
    await open('Weekly planning');
    const series = within(pane()).getByRole('group', { name: 'Answer all events in the series' });
    expect(pressed(series)).toEqual(['Accept']);
    fireEvent.click(within(series).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(answerOf('Weekly planning')).toBe('declined'));
    expect(store.outgoing.list().map((change) => change.field)).toEqual(['response', 'seriesResponse']);
  });

  it('shows Couldn’t sync with Retry when the answer stopped', async () => {
    renderSheet();
    await open('Pricing review');
    fireEvent.click(within(pane()).getByRole('button', { name: /^Accept/ }));
    await waitFor(() => expect(store.outgoing.list()).toHaveLength(1));
    const [queued] = store.outgoing.forItem(ids['Pricing review'] as string);
    store.outgoing.fail([queued?.id as number], {
      error: 'This event is no longer in Google Calendar.',
      failed: true,
      nextAttemptAt: null,
    });
    // Ares (or anything) changing reads it again.
    act(() => {
      for (const each of aresListeners) each();
    });
    const alert = await within(pane()).findByRole('alert');
    expect(alert.textContent).toContain('Couldn’t sync · This event is no longer in Google Calendar.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(store.outgoing.list()[0]?.status).toBe('pending'));
  });

  it('shows Couldn’t sync with Retry on an event Commander made whose move stopped (#206)', async () => {
    const made = store.createEvent(
      {
        kind: 'meeting',
        account: ALEX,
        title: 'Roadmap sync',
        start: { at: Date.parse('2026-10-05T16:30:00Z'), timeZone: LONDON, date: null },
        end: { at: Date.parse('2026-10-05T17:00:00Z'), timeZone: LONDON, date: null },
      },
      { by: { kind: 'user' } },
    ).itemId;
    store.outgoing.settle(store.outgoing.forItem(made).map((row) => row.id));
    store.moveEvent(
      made,
      {
        start: { at: Date.parse('2026-10-05T17:00:00Z'), timeZone: LONDON, date: null },
        end: { at: Date.parse('2026-10-05T17:30:00Z'), timeZone: LONDON, date: null },
        allDay: false,
      },
      { by: { kind: 'user' } },
    );
    const [move] = store.outgoing.forItem(made);
    store.outgoing.fail([move?.id as number], {
      error: 'Google Calendar doesn’t have this event.',
      failed: true,
      nextAttemptAt: null,
    });
    renderSheet();
    await waitFor(() =>
      expect(within(row('Roadmap sync')).getByTestId('row-sync').textContent).toBe('Couldn’t sync'),
    );
    await open('Roadmap sync');
    const alert = await within(pane()).findByRole('alert');
    expect(alert.textContent).toContain('Couldn’t sync · Google Calendar doesn’t have this event.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(store.outgoing.forItem(made)[0]?.status).toBe('pending'));
    // On its way again, it says so instead.
    await waitFor(() => expect(within(pane()).getByTestId('answer-sync').textContent).toContain('Saving to'));
  });

  it('shows the note when an answer given in Google Calendar won', async () => {
    store.saveFromSource({
      source: 'google-calendar',
      account: ALEX,
      items: [
        invitation('pricing', 'Pricing review', '2026-10-05T13:00:00Z', '2026-10-05T14:00:00Z', {
          myResponse: 'declined',
        }),
      ],
      why: 'Changed in Google Calendar at 10:20',
    });
    renderSheet();
    await open('Pricing review');
    expect(within(pane()).getByTestId('answer-sync').textContent).toBe('Changed in Google Calendar at 10:20');
  });
});

describe('Ares’s suggested replies', () => {
  function suggest(answer: string) {
    const outcome = gate.propose({
      actionKind: 'act-for-you',
      action: REPLY_TO_INVITATIONS,
      section: 'calendar',
      itemId: ids['Pricing review'] as string,
      itemActions: [
        { type: 'edit-fields', itemId: ids['Pricing review'] as string, fields: { response: answer } },
      ],
      confidence: 0.9,
      reason: 'You’re already in Board prep with Leo then',
      causedBy: { itemId: ids['Pricing review'] as string },
    });
    expect(outcome.decision).toBe('ask');
  }

  it('show on the invitation’s row and in the detail pane, with the reason, and Send answers it', async () => {
    suggest('declined');
    renderSheet();
    await waitFor(() => expect(within(row('Pricing review')).getByTestId('suggested-reply')).toBeTruthy());
    expect(within(row('Pricing review')).getByTestId('suggested-reply').textContent).toContain(
      'Ares suggests: Decline · You’re already in Board prep with Leo then',
    );
    await open('Pricing review');
    const card = within(pane()).getByTestId('suggested-reply');
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(answerOf('Pricing review')).toBe('declined'));
    await waitFor(() => expect(within(pane()).queryByTestId('suggested-reply')).toBeNull());
    expect(store.outgoing.list()).toMatchObject([{ itemId: ids['Pricing review'], field: 'response' }]);
    // Sent by the User, as one change Ctrl+Z takes back.
    press('z', { ctrlKey: true });
    await waitFor(() => expect(answerOf('Pricing review')).toBe('needs-action'));
  });

  it('go for good when dismissed, answering nothing', async () => {
    suggest('declined');
    renderSheet();
    await waitFor(() => expect(within(row('Pricing review')).getByTestId('suggested-reply')).toBeTruthy());
    fireEvent.click(within(row('Pricing review')).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByTestId('suggested-reply')).toBeNull());
    expect(answerOf('Pricing review')).toBe('needs-action');
    expect(gate.activity({ statuses: ['dismissed'] })).toHaveLength(1);
  });
});
