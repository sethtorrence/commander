// @vitest-environment jsdom

import { createFiling } from '@commander/core/src/agent/filing';
import { openGate } from '@commander/core/src/autonomy/gate';
import type { ItemStore } from '@commander/core/src/item-store';
import { type EventDetail, FILE_INTO_PROJECTS, type Project, type SourceItem } from '@commander/domain';
import type { AccountSyncStatus, GoogleAccountSummary, OutlookAccountSummary } from '@commander/domain/ipc';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openTestItemStore } from '../../item-store/test-item-store';
import { ProjectsProvider } from '../../projects/context';
import { type ProjectsClient, projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes, useShortcutList } from '../../shortcuts/react';
import { FrameControlsProvider, SectionProvider } from '../section';
import { calendar as definition } from '.';
import { CalendarSheet } from './CalendarSheet';
import {
  type CalendarAccount,
  type CalendarAccountsClient,
  type CalendarEvents,
  calendarEventsIn,
} from './calendar-events';
import { type CalendarSettingsClient, calendarSettingsIn } from './calendar-settings';

// The Calendar Section against a real Item store on a temporary database, with events saved the way
// Google Calendar sync saves them (saveFromSource), a stand-in for the Google Accounts, a fixed clock
// and the London time zone.

const ALEX = 'google:104512345678901234567';
const PRIMARY = 'alex@gmail.test';
const STANDUPS = 'c_tl_standups@group.calendar.google.com';
const LONDON = 'Europe/London';
// Monday 5 October 2026, 10:30 in London.
const NOW = Date.UTC(2026, 9, 5, 9, 30);
// The last sync is 10:02 on NOW's local day (the status line shows it in the computer's own zone).
const SYNCED_AT = new Date(NOW).setHours(10, 2, 0, 0);
const at = (iso: string) => Date.parse(iso);

let store: ItemStore;
let events: CalendarEvents;
let settings: CalendarSettingsClient;
let itemStoreClient: ReturnType<typeof openTestItemStore>['client'];
let listedShortcuts: string[] = [];
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
  lastSyncedAt: SYNCED_AT,
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

function fakeAccounts(initial: CalendarAccount[]) {
  let accounts = initial;
  const listeners = new Set<(accounts: CalendarAccount[]) => void>();
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
    change(next: CalendarAccount[]) {
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
  settings = calendarSettingsIn(opened_.client);
  itemStoreClient = opened_.client;
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
  listedShortcuts = useShortcutList().map((shortcut) => shortcut.label);
  return children;
}
const registryLabels = () => listedShortcuts;

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
                  settings={settings}
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
    // The count is set in an effect, which can run just after the Agenda shows.
    await waitFor(() => expect(controls.setTabCount).toHaveBeenLastCalledWith('calendar', 2));
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

  it('shows an Outlook Account’s events beside Google’s, groups the calendars by Account, and hands Outlook events to Outlook on the web', async () => {
    const SAM = 'outlook:fake-tenant-0001:6f1c2a40-0000-4000-8000-00000000a001';
    const UPN = 'sam@contoso.test';
    const outlookSync = syncStatus({ account: SAM, source: 'outlook-calendar' });
    const sam: OutlookAccountSummary = {
      id: SAM,
      source: 'outlook',
      name: `Outlook · ${UPN}`,
      userPrincipalName: UPN,
      method: 'oauth',
      status: 'connected',
      user: { id: '6f1c2a40-0000-4000-8000-00000000a001', name: 'Sam Rivera' },
      sync: null,
      sources: [
        { source: 'outlook', granted: true, enabled: false },
        { source: 'outlook-calendar', granted: true, enabled: true, sync: outlookSync },
      ],
      personal: false,
    };
    accounts = fakeAccounts([alex(), sam]);
    store.calendars.listed(SAM, 'outlook-calendar', [
      { id: 'AAMk-default=', name: 'Calendar', colour: '#0078d4', primary: true, accessRole: 'owner' },
    ]);
    const webUrl = 'https://outlook.office365.com/owa/?itemid=AAMk-1on1%3D&exvsurl=1&path=/calendar/item';
    const oneOnOne = event('1on1', '1:1 with Dana', '2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z', {
      calendar: { id: 'AAMk-default=', name: 'Calendar', colour: '#0078d4' },
      accountEmail: UPN,
      webUrl,
    });
    store.saveFromSource({
      source: 'outlook-calendar',
      account: SAM,
      items: [{ ...oneOnOne, externalId: 'AAMk-1on1=' }],
    });
    renderSheet();

    await waitFor(() =>
      expect(days()[0]).toEqual([
        'Today · Monday 5 October',
        [
          '09:00–09:15 TL standup',
          '11:00–11:30 1:1 with Dana',
          '12:30–13:30 Lunch with Priya',
          '14:00–15:00 Design review',
        ],
      ]),
    );
    await waitFor(() => expect(controls.setTabCount).toHaveBeenLastCalledWith('calendar', 3));
    await waitFor(() => expect(accounts.refreshed).toEqual([ALEX, SAM]));

    // The side column: each Account's calendars under its address.
    const groups = screen.getAllByTestId('calendar-group');
    expect(groups.map((group) => group.querySelector('p')?.textContent)).toEqual([
      `${PRIMARY} · Google`,
      `${UPN} · Outlook`,
    ]);
    expect(
      within(groups[1] as HTMLElement)
        .getAllByRole('switch')
        .map((each) => each.getAttribute('aria-label')),
    ).toEqual(['Show Calendar']);

    // New event for each Account at its own provider; Edit opens the Outlook event at its web link.
    fireEvent.click(screen.getByRole('button', { name: `New event · ${UPN}` }));
    expect(opened).toEqual([
      'https://outlook.office.com/calendar/deeplink/compose?login_hint=sam%40contoso.test',
    ]);
    fireEvent.click(screen.getByRole('listitem', { name: /1:1 with Dana/ }));
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /Edit in Outlook/ })));
    expect(opened[1]).toBe(`${webUrl}&login_hint=sam%40contoso.test`);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(accounts.refreshed).toEqual([ALEX, SAM, SAM]);
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

const blocks = () =>
  screen.queryAllByTestId('calendar-block').map((block) => block.getAttribute('aria-label'));
const bars = () => screen.queryAllByTestId('calendar-allday').map((bar) => bar.getAttribute('aria-label'));
const columnHeads = () =>
  Array.from(screen.getByTestId('time-grid').querySelectorAll('[data-testid="grid-day"]'), (head) =>
    head.textContent?.trim(),
  );
const rangeTitle = () => screen.getByTestId('calendar-range').textContent;

describe('the Day, Week and Month views', () => {
  it('switches to Week with w: a time grid of the week, all-day events above, and the choice remembered', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getAllByTestId('calendar-event')).toHaveLength(5));
    press('w');
    await waitFor(() => expect(screen.getByTestId('time-grid')).toBeTruthy());
    expect(columnHeads()).toEqual(['Mon 5', 'Tue 6', 'Wed 7', 'Thu 8', 'Fri 9', 'Sat 10', 'Sun 11']);
    await waitFor(() =>
      expect(blocks()).toEqual([
        '09:00–09:15 TL standup',
        '12:30–13:30 Lunch with Priya',
        '14:00–15:00 Design review',
        '10:00–11:00 Planning',
      ]),
    );
    expect(bars()).toEqual(['All day Local-first conference']);
    expect(screen.queryByTestId('agenda')).toBeNull();
    expect(rangeTitle()).toBe('5 – 11 October 2026');
    expect(screen.getByRole('radio', { name: /Week/ }).getAttribute('aria-checked')).toBe('true');
    // The "now" line on today's column only.
    expect(screen.getAllByTestId('now-line')).toHaveLength(1);
    expect(screen.getByTestId('now-line').closest('[data-day]')?.getAttribute('data-day')).toBe('2026-10-05');

    cleanup();
    renderSheet();
    await waitFor(() => expect(blocks()).toHaveLength(4));
  });

  it('moves between views, ranges and today with d, w, m, l, [, ] and t', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getAllByTestId('calendar-event')).toHaveLength(5));
    press('d');
    await waitFor(() => expect(rangeTitle()).toBe('Monday 5 October 2026'));
    await waitFor(() => expect(blocks()).toHaveLength(3));
    press(']');
    press(']');
    await waitFor(() => expect(rangeTitle()).toBe('Wednesday 7 October 2026'));
    await waitFor(() => expect(blocks()).toEqual(['10:00–11:00 Planning']));
    expect(bars()).toEqual(['All day Local-first conference']);
    press('m');
    await waitFor(() => expect(rangeTitle()).toBe('October 2026'));
    press(']');
    await waitFor(() => expect(rangeTitle()).toBe('November 2026'));
    press('t');
    await waitFor(() => expect(rangeTitle()).toBe('October 2026'));
    press('w');
    press('[');
    await waitFor(() => expect(rangeTitle()).toBe('28 September – 4 October 2026'));
    press('l');
    await waitFor(() => expect(screen.getByTestId('agenda')).toBeTruthy());
    press('t');
    await waitFor(() => expect(days()[0]?.[0]).toBe('Today · Monday 5 October'));
  });

  it('lists every view’s keys in the cheat sheet', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getAllByTestId('calendar-event')).toHaveLength(5));
    for (const label of ['Day view', 'Week view', 'Month view', 'Agenda', 'Today', 'Back', 'Forward']) {
      expect(registryLabels()).toContain(label);
    }
  });

  it('shows up to three events a day in Month, then “+N more”, which opens the day', async () => {
    store.saveFromSource({
      source: 'google-calendar',
      account: ALEX,
      items: [event('late', 'Late call', '2026-10-05T18:00:00Z', '2026-10-05T19:00:00Z')],
    });
    renderSheet();
    await waitFor(() => expect(screen.getAllByTestId('calendar-event')).toHaveLength(6));
    press('m');
    const monday = await waitFor(() => {
      const found = screen.getByTestId('month-grid').querySelector('[data-day="2026-10-05"]');
      if (!found) throw new Error('no Monday');
      return found as HTMLElement;
    });
    expect(
      within(monday)
        .getAllByTestId('month-event')
        .map((each) => each.getAttribute('aria-label')),
    ).toEqual(['09:00 TL standup', '12:30 Lunch with Priya', '14:00 Design review']);
    fireEvent.click(within(monday).getByRole('button', { name: '+1 more' }));
    await waitFor(() => expect(rangeTitle()).toBe('Monday 5 October 2026'));
    expect(blocks()).toContain('19:00–20:00 Late call');
  });

  it('opens an event from the grid with a click, or with j and Enter, and files it with b', async () => {
    const tl = store.changeProject({
      type: 'create',
      project: { name: 'Titanlink', code: 'TL', accent: 'blue' },
    }).project as Project;
    renderSheet();
    await waitFor(() => expect(screen.getAllByTestId('calendar-event')).toHaveLength(5));
    press('w');
    await waitFor(() => expect(blocks()).toHaveLength(4));
    fireEvent.click(screen.getByRole('listitem', { name: '14:00–15:00 Design review' }));
    await waitFor(() =>
      expect(within(detail() as HTMLElement).getByRole('heading', { name: 'Design review' })).toBeTruthy(),
    );
    // j moves on in time order: the next is Wednesday's all-day conference, then Planning.
    press('j');
    press('j');
    await waitFor(() =>
      expect(within(detail() as HTMLElement).getByRole('heading', { name: 'Planning' })).toBeTruthy(),
    );
    press('b');
    fireEvent.click(await waitFor(() => screen.getByRole('option', { name: /Titanlink/ })));
    const planning = screen.getByRole('listitem', { name: '10:00–11:00 Planning' });
    await waitFor(() =>
      expect(store.get(planning.getAttribute('data-item-id') ?? '')?.item.filing).toEqual({
        projectId: tl.id,
        filedBy: 'user',
      }),
    );
    // The Project filter narrows the grid, with this week's counts.
    const filterButton = screen.getByRole('button', { name: /Titanlink/ });
    expect(filterButton.textContent).toContain('1');
    fireEvent.click(filterButton);
    await waitFor(() => expect(blocks()).toEqual(['10:00–11:00 Planning']));
    expect(bars()).toEqual([]);
    // Undo puts it back.
    press('z', { ctrlKey: true });
    await waitFor(() =>
      expect(store.get(planning.getAttribute('data-item-id') ?? '')?.item.filing).toBeNull(),
    );
  });

  it('says when the days shown reach past what calendar sync keeps, pointing to the provider', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getAllByTestId('calendar-event')).toHaveLength(5));
    press('m');
    expect(screen.queryByTestId('calendar-outside')).toBeNull();
    press('[');
    press('[');
    const line = await waitFor(() => screen.getByTestId('calendar-outside'));
    expect(line.textContent).toBe('Older events aren’t kept in Commander. They live in Google Calendar ↗.');
    fireEvent.click(within(line).getByRole('link', { name: /Google Calendar/ }));
    expect(opened).toEqual(['https://calendar.google.com/calendar/r']);
  });
});

const SAM = 'outlook:fake-tenant-0001:6f1c2a40-0000-4000-8000-00000000a001';
const UPN = 'sam@contoso.test';

// Sam's Outlook Account beside Alex's Google one, with a busy board prep over Monday's design review.
function withSam(extra: Partial<EventDetail> = {}) {
  const outlookSync = syncStatus({ account: SAM, source: 'outlook-calendar' });
  const sam: OutlookAccountSummary = {
    id: SAM,
    source: 'outlook',
    name: `Outlook · ${UPN}`,
    userPrincipalName: UPN,
    method: 'oauth',
    status: 'connected',
    user: { id: '6f1c2a40-0000-4000-8000-00000000a001', name: 'Sam Rivera' },
    sync: null,
    sources: [
      { source: 'outlook', granted: true, enabled: false },
      { source: 'outlook-calendar', granted: true, enabled: true, sync: outlookSync },
    ],
    personal: false,
  };
  accounts = fakeAccounts([alex(), sam]);
  store.calendars.listed(SAM, 'outlook-calendar', [
    { id: 'AAMk-default=', name: 'Calendar', colour: '#0078d4', primary: true, accessRole: 'owner' },
  ]);
  const board = event('board', 'Board prep', '2026-10-05T13:30:00Z', '2026-10-05T14:30:00Z', {
    calendar: { id: 'AAMk-default=', name: 'Calendar', colour: '#0078d4' },
    accountEmail: UPN,
    start: { at: at('2026-10-05T13:30:00Z'), timeZone: 'America/New_York', date: null },
    end: { at: at('2026-10-05T14:30:00Z'), timeZone: 'America/New_York', date: null },
    ...extra,
  });
  store.saveFromSource({
    source: 'outlook-calendar',
    account: SAM,
    items: [{ ...board, externalId: 'AAMk-board=' }],
  });
}

describe('clashes between Accounts', () => {
  it('marks both events in every view and says what clashes in the detail pane', async () => {
    withSam();
    renderSheet();
    await waitFor(() => expect(screen.getAllByTestId('calendar-event')).toHaveLength(6));
    const marked = (testId: string) =>
      screen
        .getAllByTestId(testId)
        .filter((each) => within(each).queryByTestId('clash-mark'))
        .map((each) => each.getAttribute('aria-label'));
    expect(marked('calendar-event')).toEqual(['14:00–15:00 Design review', '14:30–15:30 Board prep']);

    press('w');
    await waitFor(() =>
      expect(marked('calendar-block')).toEqual(['14:00–15:00 Design review', '14:30–15:30 Board prep']),
    );
    press('m');
    // Monday holds four events: Board prep is the one behind "+1 more".
    await waitFor(() => expect(marked('month-event')).toEqual(['14:00 Design review']));
    fireEvent.click(screen.getByRole('button', { name: '+1 more' }));
    await waitFor(() => expect(marked('calendar-block')).toHaveLength(2));

    fireEvent.click(screen.getByRole('listitem', { name: '14:30–15:30 Board prep' }));
    await waitFor(() =>
      expect(screen.getByTestId('event-clash').textContent).toBe(
        'ClashClashes with Design review in your alex@gmail.test calendar',
      ),
    );
    // Board prep was set in New York time.
    expect(screen.getByTestId('event-zone-note').textContent).toBe('Set in New York time: 09:30–10:30 there');
  });

  it('never marks a declined or free event', async () => {
    withSam({ myResponse: 'declined' });
    renderSheet();
    await waitFor(() => expect(screen.getAllByTestId('calendar-event')).toHaveLength(6));
    expect(screen.queryAllByTestId('clash-mark')).toHaveLength(0);
  });
});

describe('the second time zone', () => {
  it('adds a column of the second zone’s hours in Day and Week, and its time in the detail pane', async () => {
    await settings.saveSecondTimeZone('America/New_York');
    renderSheet();
    await waitFor(() => expect(screen.getAllByTestId('calendar-event')).toHaveLength(5));
    press('w');
    await waitFor(() => expect(screen.getByTestId('second-zone-head').textContent).toBe('New York'));
    const hours = screen.getAllByTestId('second-zone-hour').map((each) => each.textContent);
    // From 01:00 London: 20:00 the evening before in New York; 15:00 London is 10:00 there.
    expect(hours[0]).toBe('20:00');
    expect(hours[14]).toBe('10:00');
    press('d');
    await waitFor(() => expect(screen.getByTestId('second-zone-head')).toBeTruthy());

    fireEvent.click(screen.getByRole('listitem', { name: '14:00–15:00 Design review' }));
    await waitFor(() =>
      expect(screen.getByTestId('event-zones').textContent).toBe('14:00 here · 09:00 New York'),
    );

    // Cleared in Settings, it goes at once.
    await act(() => settings.saveSecondTimeZone(null));
    await waitFor(() => expect(screen.queryByTestId('second-zone-head')).toBeNull());
    expect(screen.queryByTestId('event-zones')).toBeNull();
  });
});

describe('Ares’s filing of events', () => {
  it('shows his dashed Badge on an event he wasn’t sure about in every view, and Confirm files it', async () => {
    const tl = store.changeProject({
      type: 'create',
      project: { name: 'Titanlink', code: 'TL', accent: 'blue' },
    }).project as Project;
    const gate = openGate({ itemStore: store });
    gate.registerAction({ action: FILE_INTO_PROJECTS, actionKind: 'organise', name: 'File into Projects' });
    const filing = createFiling({ itemStore: store, gate });
    const review = store.query({ kinds: ['event'] }).find((item) => item.title === 'Design review');
    gate.propose({
      action: FILE_INTO_PROJECTS,
      actionKind: 'organise',
      section: 'calendar',
      itemId: review?.id as string,
      itemActions: [
        {
          type: 'update',
          itemId: review?.id as string,
          changes: { filing: { projectId: tl.id, filedBy: 'ares' } },
        },
      ],
      confidence: 0.5,
      reason: 'Dana runs Titanlink design',
    });
    // The window's autonomy channel, answered by the Core's filing over the same gate.
    const autonomy = async (request: { op: string; proposalId: number; projectId: string | null }) => {
      if (request.op !== 'settle-filing') throw new Error(`Not here: ${request.op}`);
      return filing.settle(request.proposalId, request.projectId);
    };
    projects = projectsIn(itemStoreClient, () => autonomy as never);
    renderSheet();
    const dashed = () =>
      document.querySelectorAll(`[data-item-id="${review?.id}"] [data-suggested="true"]`).length;
    await waitFor(() => expect(dashed()).toBe(1));
    press('w');
    await waitFor(() => expect(dashed()).toBe(1));
    press('m');
    await waitFor(() => expect(dashed()).toBe(1));

    fireEvent.click(screen.getByRole('listitem', { name: '14:00 Design review' }));
    const suggestion = await waitFor(() => screen.getByTestId('suggested-filing'));
    fireEvent.click(within(suggestion).getByRole('button', { name: 'Confirm Titanlink' }));
    await waitFor(() =>
      expect(store.get(review?.id as string)?.item.filing).toEqual({ projectId: tl.id, filedBy: 'user' }),
    );
    await waitFor(() => expect(dashed()).toBe(0));
  });
});
