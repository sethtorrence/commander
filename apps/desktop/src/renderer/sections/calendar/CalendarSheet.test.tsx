// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { EventDetail, Project, SourceItem } from '@commander/domain';
import type { AccountSyncStatus, GoogleAccountSummary } from '@commander/domain/ipc';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openTestItemStore } from '../../item-store/test-item-store';
import { ProjectsProvider } from '../../projects/context';
import { type ProjectsClient, projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes } from '../../shortcuts/react';
import { FrameControlsProvider, SectionProvider } from '../section';
import { calendar as definition } from '.';
import { CalendarSheet } from './CalendarSheet';
import { type CalendarAccountsClient, type CalendarEvents, calendarEventsIn } from './calendar-events';

// The Calendar Section against a real Item store on a temporary database, with events saved the way
// Google Calendar sync saves them (saveFromSource), a stand-in for the Google Accounts, a fixed clock
// and the London time zone.

const ALEX = 'google:104512345678901234567';
const PRIMARY = 'alex@gmail.test';
const STANDUPS = 'c_tl_standups@group.calendar.google.com';
const LONDON = 'Europe/London';
// Monday 5 October 2026, 10:30 in London.
const NOW = Date.UTC(2026, 9, 5, 9, 30);
const at = (iso: string) => Date.parse(iso);

let store: ItemStore;
let events: CalendarEvents;
let projects: ProjectsClient;
let close: () => void;
let opened: string[];
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };

function event(
  id: string,
  title: string,
  start: string,
  end: string,
  extra: Partial<EventDetail> = {},
  calendarId = PRIMARY,
): SourceItem {
  const detail: EventDetail = {
    kind: 'event',
    calendar:
      calendarId === STANDUPS
        ? { id: STANDUPS, name: 'Titanlink Standups', colour: '#33b679' }
        : { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7' },
    accountEmail: PRIMARY,
    start: { at: at(start), timeZone: LONDON, date: null },
    end: { at: at(end), timeZone: LONDON, date: null },
    allDay: false,
    location: null,
    description: null,
    organiser: { email: PRIMARY, name: null, self: true },
    attendees: [],
    myResponse: null,
    meetingUrl: null,
    busy: true,
    private: false,
    seriesId: null,
    webUrl: `https://www.google.com/calendar/event?eid=${id}`,
    createdByCommander: null,
    ...extra,
  };
  return { externalId: `${calendarId}/${id}`, kind: 'event', title, people: [PRIMARY], detail };
}

const syncStatus = (overrides: Partial<AccountSyncStatus> = {}): AccountSyncStatus => ({
  account: ALEX,
  source: 'google-calendar',
  activity: 'idle',
  cadenceMinutes: 15,
  cadenceChoices: [15, 30, 60],
  lastSyncedAt: new Date(2026, 9, 5, 10, 2).getTime(),
  nextSyncAt: null,
  itemCount: 4,
  problem: null,
  outgoing: { pending: 0, failed: 0 },
  ...overrides,
});

const alex = (sync: AccountSyncStatus | null = syncStatus()): GoogleAccountSummary => ({
  id: ALEX,
  source: 'google',
  name: `Google · ${PRIMARY}`,
  email: PRIMARY,
  method: 'oauth',
  status: 'connected',
  user: { id: '104512345678901234567', name: 'Alex Kim' },
  sync,
  sources: [
    { source: 'gmail', granted: true, enabled: false },
    { source: 'google-calendar', granted: true, enabled: true, sync },
  ],
});

function fakeAccounts(initial: GoogleAccountSummary[]) {
  let accounts = initial;
  const listeners = new Set<(accounts: GoogleAccountSummary[]) => void>();
  const refreshed: string[] = [];
  const client: CalendarAccountsClient = {
    list: async () => accounts,
    refresh: async (id) => {
      refreshed.push(id);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    client,
    refreshed,
    change(next: GoogleAccountSummary[]) {
      accounts = next;
      act(() => {
        for (const listener of listeners) listener(next);
      });
    },
  };
}

let accounts: ReturnType<typeof fakeAccounts>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const opened_ = openTestItemStore(() => NOW);
  ({ store, close } = opened_);
  events = calendarEventsIn(opened_.client);
  projects = projectsIn(opened_.client);
  accounts = fakeAccounts([alex()]);
  opened = [];
  localStorage.clear();
  controls.openSection.mockReset();
  controls.setTabCount.mockReset();
  Element.prototype.scrollIntoView = () => {};
  store.calendars.listed(ALEX, 'google-calendar', [
    { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7', primary: true, accessRole: 'owner' },
    { id: STANDUPS, name: 'Titanlink Standups', colour: '#33b679', primary: false, accessRole: 'owner' },
  ]);
  store.saveFromSource({
    source: 'google-calendar',
    account: ALEX,
    items: [
      event(
        'standup',
        'TL standup',
        '2026-10-05T08:00:00Z',
        '2026-10-05T08:15:00Z',
        { seriesId: 's' },
        STANDUPS,
      ),
      event('review', 'Design review', '2026-10-05T13:00:00Z', '2026-10-05T14:00:00Z', {
        location: 'Room 4',
        description: 'Agenda: https://docs.example.test/review\n\n![tracker](https://tracker.test/pixel.png)',
        organiser: { email: 'dana@titanlink.test', name: 'Dana Ruiz', self: false },
        attendees: [
          {
            email: 'dana@titanlink.test',
            name: 'Dana Ruiz',
            self: false,
            response: 'accepted',
            organiser: true,
            optional: false,
            resource: false,
          },
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
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
      }),
      event('lunch', 'Lunch with Priya', '2026-10-05T11:30:00Z', '2026-10-05T12:30:00Z'),
      {
        ...event('conf', 'Local-first conference', '2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z'),
        detail: {
          ...(event('conf', '', '2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z').detail as EventDetail),
          allDay: true,
          start: { at: at('2026-10-07T00:00:00Z'), timeZone: null, date: '2026-10-07' },
          end: { at: at('2026-10-08T00:00:00Z'), timeZone: null, date: '2026-10-08' },
        },
      },
      event('wed', 'Planning', '2026-10-07T09:00:00Z', '2026-10-07T10:00:00Z'),
    ],
  });
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

const place = { definition, number: 6, total: 8, active: true };

function renderSheet() {
  return render(
    <ShortcutProvider>
      <ProjectsProvider client={projects} storage={localStorage}>
        <FrameControlsProvider value={controls}>
          <SectionProvider place={place}>
            <ShortcutScope scope="calendar" group="Calendar">
              <Active>
                <CalendarSheet
                  events={events}
                  accounts={accounts.client}
                  timeZone={LONDON}
                  open={(url) => opened.push(url)}
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

const days = () =>
  Array.from(screen.getByTestId('agenda').querySelectorAll('section'), (day) => [
    day.getAttribute('aria-label'),
    [...day.querySelectorAll('[data-testid="calendar-event"]')].map((row) => row.getAttribute('aria-label')),
  ]);
const detail = () => screen.queryByRole('region', { name: 'Event detail' });

describe('the Calendar sheet', () => {
  it('lists the Agenda by day, today first, all-day events at the top, and counts today’s still to come', async () => {
    renderSheet();
    await waitFor(() =>
      expect(days()).toEqual([
        [
          'Today · Monday 5 October',
          ['09:00–09:15 TL standup', '12:30–13:30 Lunch with Priya', '14:00–15:00 Design review'],
        ],
        ['Wednesday 7 October', ['All day Local-first conference', '10:00–11:00 Planning']],
      ]),
    );
    expect(controls.setTabCount).toHaveBeenLastCalledWith('calendar', 2);
    expect(screen.getByTestId('calendar-sync-status').textContent).toBe('Synced 10:02');
  });

  it('asks every Account’s Google Calendar to sync when opened', async () => {
    renderSheet();
    await waitFor(() => expect(accounts.refreshed).toEqual([ALEX]));
  });

  it('opens an event with j, k and Enter, showing every field and the description as safe text', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getAllByTestId('calendar-event')).toHaveLength(5));
    press('j');
    press('j');
    press('Enter');
    const pane = await waitFor(() => {
      const found = detail();
      if (!found) throw new Error('no detail pane');
      return within(found);
    });
    expect(pane.getByRole('heading', { name: 'Design review' })).toBeTruthy();
    expect(pane.getByTestId('event-when').textContent).toBe('Monday 5 October · 14:00–15:00');
    const field = (name: string) => detail()?.querySelector(`[data-field="${name}"] dd`)?.textContent;
    expect(field('location')).toBe('Room 4');
    expect(field('organiser')).toBe('Dana Ruiz');
    expect(field('response')).toBe('Not answered');
    expect(field('meeting')).toBe('meet.google.com/abc-defg-hij');
    expect(field('time-zone')).toBe(LONDON);
    expect(field('busy')).toBe('Busy');
    expect(pane.getByTestId('event-guests').textContent).toContain('Dana Ruiz · organiser');
    const description = pane.getByTestId('event-description');
    expect(description.querySelector('img')).toBeNull();
    expect(description.querySelector('a[href="https://docs.example.test/review"]')).toBeTruthy();
    expect(pane.getByText('Added from Google Calendar')).toBeTruthy();
  });

  it('hands Edit and New event to Google Calendar as the Account, and syncs it again on coming back', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getAllByTestId('calendar-event')).toHaveLength(5));
    fireEvent.click(screen.getByRole('button', { name: /New event/ }));
    expect(opened).toEqual(['https://calendar.google.com/calendar/r/eventedit?authuser=alex%40gmail.test']);

    fireEvent.click(screen.getAllByTestId('calendar-event')[0] as HTMLElement);
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /Edit in Google Calendar/ })));
    expect(opened[1]).toBe('https://www.google.com/calendar/event?eid=standup&authuser=alex%40gmail.test');

    await waitFor(() => expect(accounts.refreshed).toEqual([ALEX]));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(accounts.refreshed).toEqual([ALEX, ALEX]);
  });

  it('files an event with b, and the Project filter narrows the Agenda', async () => {
    const tl = store.changeProject({
      type: 'create',
      project: { name: 'Titanlink', code: 'TL', accent: 'blue' },
    }).project as Project;
    renderSheet();
    await waitFor(() => expect(screen.getAllByTestId('calendar-event')).toHaveLength(5));
    press('b');
    const option = await waitFor(() => screen.getByRole('option', { name: /Titanlink/ }));
    fireEvent.click(option);
    await waitFor(() =>
      expect(
        store.get(screen.getAllByTestId('calendar-event')[0]?.getAttribute('data-item-id') ?? '')?.item
          .filing,
      ).toEqual({
        projectId: tl.id,
        filedBy: 'user',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Titanlink/ }));
    await waitFor(() =>
      expect(screen.getAllByTestId('calendar-event').map((row) => row.getAttribute('aria-label'))).toEqual([
        '09:00–09:15 TL standup',
      ]),
    );
  });

  it('shows or hides each calendar in this view from the side column', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getAllByTestId('calendar-event')).toHaveLength(5));
    fireEvent.click(screen.getByRole('switch', { name: 'Show Titanlink Standups' }));
    await waitFor(() => expect(screen.getAllByTestId('calendar-event')).toHaveLength(4));
    expect(screen.queryByRole('listitem', { name: /TL standup/ })).toBeNull();
    expect(JSON.parse(localStorage.getItem('commander.calendar.hidden') ?? '[]')).toEqual([
      `${ALEX}/${STANDUPS}`,
    ]);
  });

  it('reads the events again when a sync finishes, and says when one fails', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getAllByTestId('calendar-event')).toHaveLength(5));
    store.saveFromSource({
      source: 'google-calendar',
      account: ALEX,
      items: [event('late', 'Late call', '2026-10-05T18:00:00Z', '2026-10-05T19:00:00Z')],
    });
    accounts.change([alex(syncStatus({ lastSyncedAt: NOW }))]);
    await waitFor(() => expect(screen.getAllByTestId('calendar-event')).toHaveLength(6));

    accounts.change([
      alex(
        syncStatus({
          problem: { kind: 'failed', message: 'Google Calendar couldn’t answer just now (HTTP 503).' },
        }),
      ),
    ]);
    await waitFor(() =>
      expect(screen.getByTestId('calendar-sync-status').textContent).toBe(
        'Google Calendar couldn’t answer just now (HTTP 503).',
      ),
    );
  });
});
