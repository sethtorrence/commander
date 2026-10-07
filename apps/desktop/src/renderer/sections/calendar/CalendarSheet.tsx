import { ANSWER_NAMES, canAnswer, INVITATION_ANSWERS } from '@commander/domain';
import { Button, ButtonGroup, cn, Kbd, Led, Switch } from '@commander/ui';
import { type ComponentType, type ReactNode, useCallback, useEffect, useRef } from 'react';
import { useReveal } from '../../frame/reveal';
import { useNow } from '../../frame/use-now';
import { useAresKey } from '../../links/AresButton';
import { PickBadgeProvider, useBadgePicker } from '../../projects/BadgePicker';
import { SectionProjectFilter } from '../../projects/badges';
import { useProjectFilter, useProjects } from '../../projects/context';
import { SideCard } from '../../projects/page/SideCard';
import { SettingsLink } from '../../settings/SettingsLink';
import { useShortcuts } from '../../shortcuts/react';
import type { AutonomyClient } from '../ares/activity';
import { supersededNote } from '../linear/editing';
import { EmptySheet, SectionSheet, useOpenSection, useSection, useTabCount } from '../section';
import { sectionFor } from '../todos/links';
import { TodoGroup } from '../todos/TodoGroup';
import {
  type AgendaEntry,
  addDays,
  type CalendarEvent,
  editUrl,
  newEventUrl,
  newOutlookEventUrl,
} from './agenda';
import {
  addressOf,
  type CalendarAccount,
  type CalendarAccountsClient,
  type CalendarEvents,
  calendarSyncLine,
  calendarSyncOf,
  type EventLink,
} from './calendar-events';
import { type CalendarSettingsClient, useSecondTimeZone } from './calendar-settings';
import { EventDetail } from './EventDetail';
import { CalendarSwatch, EventRow } from './EventRow';
import { requestFindTime } from './FindTime';
import { FocusSuggestionBlocks, FocusSuggestionRows, FocusTimePanel } from './FocusTime';
import { useFocusTime, withSuggestionDays } from './focus-time';
import {
  ANSWER_KEYS,
  EventSync,
  InvitationPanel,
  RowAnswer,
  RowSync,
  SuggestedReplyCard,
} from './InvitationAnswer';
import type { InvitationsClient } from './invitations';
import { MonthGrid } from './MonthGrid';
import { TimeGrid } from './TimeGrid';
import { keyOfCalendar, useCalendar } from './use-calendar';
import { useInvitations } from './use-invitations';
import { CALENDAR_VIEWS, type CalendarView, rangeTitle, VIEW_NAMES } from './views';

// Enter opens the selected event, except on a control that Enter presses (a button, a link).
const onPressable = () => !!document.activeElement?.closest('button, a[href], summary, [role="button"]');

const KEYS: [ReactNode, string][] = [
  [
    <>
      <Kbd>[</Kbd>
      <Kbd>T</Kbd>
      <Kbd>]</Kbd>
    </>,
    'Back · Today · On',
  ],
  [
    <>
      <Kbd>J</Kbd>
      <Kbd>K</Kbd>
    </>,
    'Move',
  ],
  [<Kbd key="enter">↵</Kbd>, 'Open'],
  [<Kbd key="b">B</Kbd>, 'Project'],
  [<Kbd key="z">Ctrl Z</Kbd>, 'Undo'],
];

function Keys() {
  return (
    <div className="grid grid-cols-[auto_auto] gap-x-3.5 gap-y-[5px] pb-0.5 font-mono text-label leading-[19px] font-medium uppercase tracking-label whitespace-nowrap text-muted [&_kbd]:h-[17px] [&_kbd]:min-w-[17px] [&_kbd]:text-label">
      {KEYS.map(([caps, label]) => (
        <span key={label} className="flex items-center gap-[7px]">
          {caps} {label}
        </span>
      ))}
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

// Each view's key: `l` for the Agenda list, since `a` is Ares's.
const VIEW_KEYS: Record<CalendarView, string> = { day: 'd', week: 'w', month: 'm', agenda: 'l' };

/** The view switch in the sheet header: Day, Week, Month and Agenda, each with its key. */
function ViewSwitch({ view, onView }: { view: CalendarView; onView: (view: CalendarView) => void }) {
  return (
    <ButtonGroup role="radiogroup" aria-label="Calendar view">
      {CALENDAR_VIEWS.map((each) => (
        <Button
          key={each}
          role="radio"
          aria-checked={each === view}
          variant={each === view ? 'primary' : 'default'}
          onClick={() => onView(each)}
        >
          {VIEW_NAMES[each]} <Kbd>{VIEW_KEYS[each].toUpperCase()}</Kbd>
        </Button>
      ))}
    </ButtonGroup>
  );
}

// How the subtitle names the days a view shows.
const SPAN_NAMES = { day: 'this day', week: 'this week', month: 'this month' } as const;

// Where events outside the synced days live: each connected provider's calendar on the web.
const PROVIDER_LINKS = {
  google: { name: 'Google Calendar', url: 'https://calendar.google.com/calendar/r' },
  outlook: { name: 'Outlook', url: 'https://outlook.office.com/calendar/view/month' },
} as const;

// Where New event opens for an Account: Google Calendar, or Outlook on the web.
const newEventFor = (account: CalendarAccount) =>
  account.source === 'google'
    ? { url: newEventUrl(account.email), where: 'Google Calendar' }
    : {
        url: newOutlookEventUrl(account.userPrincipalName, account.personal === true),
        where: 'Outlook on the web',
      };

const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
// Without the gate (component tests), Focus time reads nothing.
const noAutonomy = (() => Promise.reject(new Error('No gate'))) as unknown as AutonomyClient;
const noActivity = () => () => {};
const openInBrowser = (url: string) => {
  window.open(url, '_blank', 'noopener,noreferrer');
};

/**
 * The Calendar Section's sheet: the sheet header, the Project filter, the sync status line, then the
 * Agenda (today first, each day's events in time order, all-day ones at the top) and, once an event
 * is opened, its detail pane. Google and Outlook Accounts' events show together. A side column lists
 * every calendar, grouped by Account, to show or hide each in this view. Opening the Section asks
 * every calendar Account to sync; Edit and New event open Google Calendar or Outlook on the web in
 * the browser, and the Account is synced again when the window regains focus.
 */
export function CalendarSheet({
  events,
  accounts,
  timeZone = systemTimeZone(),
  settings,
  open = openInBrowser,
  Prep,
  invitations = null,
  autonomy,
  onAresActivity = noActivity,
}: {
  events: CalendarEvents;
  accounts: CalendarAccountsClient;
  /** Answering invitations and Ares's suggested replies (#129); none in views that don't offer them. */
  invitations?: InvitationsClient | null;
  /** The gate, for Ares's focus block suggestions (Focus time). */
  autonomy?: AutonomyClient;
  /** Calls back whenever Ares did or suggested something. */
  onAresActivity?: (listener: () => void) => () => void;
  /** The User's time zone (the machine's), which the Agenda's days follow. */
  timeZone?: string;
  /** Settings → Calendar: the second time zone. */
  settings?: CalendarSettingsClient;
  /** Opens an address in the system browser. */
  open?: (url: string) => void;
  /** Ares's prep for the opened meeting (#130), in its detail pane. */
  Prep?: ComponentType<{ event: CalendarEvent }>;
}) {
  const { filter, include } = useProjectFilter();
  const { projects, openPage } = useProjects();
  const filtered = projects.find((project) => project.id === filter);
  const now = useNow(60_000);
  const state = useCalendar({ events, accounts, include, now: now.getTime(), timeZone });
  const { selected, selectedEntry, detailOpen, setDetailOpen } = state;
  const badges = useBadgePicker(state.apply, state.undo);
  const invites = useInvitations({
    client: invitations,
    accounts: state.accounts,
    events: state.entries,
    apply: state.apply,
  });
  const openSection = useOpenSection();
  const several = state.accounts.length > 1;
  const { active } = useSection();
  const secondTimeZone = useSecondTimeZone(settings);
  const focus = useFocusTime({
    client: autonomy ?? noAutonomy,
    onAresActivity,
    shown: active && !!autonomy,
    now: now.getTime(),
    timeZone,
    onChanged: state.reload,
  });

  useTabCount(state.loaded ? state.toCome : null);

  // Opening the Section syncs every Account's calendars; the events are read again when it comes
  // into view, and when the window regains focus (after a hand-off to Google Calendar, that Account
  // is synced again too).
  const handedOff = useRef(new Set<string>());
  const wasActive = useRef(false);
  const { refresh, reload } = state;
  useEffect(() => {
    if (active && !wasActive.current) {
      refresh();
      reload();
    }
    wasActive.current = active;
  }, [active, refresh, reload]);
  const onFocus = useCallback(() => {
    const back = [...handedOff.current];
    handedOff.current.clear();
    if (back.length) refresh(back);
    reload();
  }, [refresh, reload]);
  useEffect(() => {
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [onFocus]);

  const handOff = (url: string, accountId: string | null) => {
    if (accountId) handedOff.current.add(accountId);
    open(url);
  };

  const file = () =>
    selected &&
    badges.open({
      id: selected.id,
      title: selected.title,
      filing: selected.filing,
      filingSuggestion: selected.filingSuggestion,
    });
  const openEntry = (entry: AgendaEntry) => {
    state.select(entry);
    setDetailOpen(true);
  };

  const openLink = ({ other }: EventLink) => {
    if (other.kind === 'project') return openPage?.(other.id);
    if (other.deletedAt !== null) return;
    const section = sectionFor(other.kind);
    if (section && section !== 'calendar') openSection(section);
    else if (other.kind === 'event') void state.reveal(other.id);
  };

  const aresKey = useAresKey(selected);
  useShortcuts([
    { keys: 'j', label: 'Next event', run: () => state.moveSelection(1) },
    { keys: 'k', label: 'Previous event', run: () => state.moveSelection(-1) },
    { keys: 'Enter', label: 'Open the event', when: () => !onPressable(), run: () => setDetailOpen(true) },
    { keys: 'Escape', label: 'Close the event', when: () => detailOpen, run: () => setDetailOpen(false) },
    { keys: 'b', label: 'File under a Project', run: () => file() },
    { keys: 'Ctrl+z', label: 'Undo', run: () => void state.undo() },
    { keys: 'd', label: 'Day view', run: () => state.setView('day') },
    { keys: 'w', label: 'Week view', run: () => state.setView('week') },
    { keys: 'm', label: 'Month view', run: () => state.setView('month') },
    { keys: 'l', label: 'Agenda', run: () => state.setView('agenda') },
    { keys: 't', label: 'Today', run: () => state.goToday() },
    { keys: '[', label: 'Back', run: () => state.step(-1) },
    { keys: ']', label: 'Forward', run: () => state.step(1) },
    aresKey,
    ...INVITATION_ANSWERS.map((answer) => ({
      keys: ANSWER_KEYS[answer],
      label: `${ANSWER_NAMES[answer]} the invitation`,
      when: () => invites.enabled && !!selected && canAnswer(selected.detail),
      run: () => {
        if (selected) void invites.answer(selected, answer);
      },
    })),
  ]);
  // From the palette: open an event it found.
  useReveal('calendar', (itemId) => void state.reveal(itemId));

  // Days Ares suggests focus blocks on show in the Agenda too.
  const agendaWithFocus = withSuggestionDays(state.agenda, focus.byDay, {
    today: state.today,
    from: state.anchor,
    last: addDays(state.anchor, state.days - 1),
  });
  const status = calendarSyncLine(state.accounts, now);
  const syncing = state.accounts.some((account) => calendarSyncOf(account)?.activity === 'syncing');
  const emailOf = new Map(state.accounts.map((account) => [account.id, addressOf(account)]));
  const total = state.entries.length;
  const { view } = state;
  const selectedId = selectedEntry?.event.id ?? (detailOpen ? (selected?.id ?? null) : null);
  // How many events the days shown hold: "in the next 30 days", "this week".
  const inRange = new Set(state.entries.map((entry) => entry.event.id)).size;
  const range = rangeTitle(view, state.anchor, state.days);
  const counted =
    view === 'agenda'
      ? `${total} in ${state.anchor === state.today ? 'the next' : 'these'} ${state.days} days`
      : `${inRange} ${SPAN_NAMES[view]}`;
  // Which providers to point to for days outside the synced window.
  const providers = [...new Set(state.accounts.map((account) => account.source))].map(
    (source) => PROVIDER_LINKS[source],
  );
  const outside = state.outside.before || state.outside.after;
  // The side column's calendars, grouped by Account in the Accounts' order.
  const calendarGroups = state.accounts
    .map((account) => ({
      account,
      calendars: state.calendars.filter((calendar) => calendar.account === account.id),
    }))
    .filter((group) => group.calendars.length > 0);

  return (
    <>
      <SectionSheet
        span="wide"
        subtitle={
          <>
            <b>{state.toCome} still to come today</b>
            {filter !== 'everything' && ` ${filtered ? `in ${filtered.name}` : 'Unfiled'}`}
            {` · ${counted}`}
          </>
        }
        aside={
          <div className="flex max-w-[680px] flex-wrap items-end justify-end gap-x-5 gap-y-3">
            <ViewSwitch view={view} onView={state.setView} />
            {state.accounts.length > 0 && (
              <Button onClick={requestFindTime} title="Find a time free for you and your guests">
                Find time
              </Button>
            )}
            {state.accounts.length > 0 && (
              <ButtonGroup>
                {state.accounts.map((account) => {
                  const { url, where } = newEventFor(account);
                  const address = addressOf(account);
                  return (
                    <Button
                      key={account.id}
                      onClick={() => handOff(url, account.id)}
                      title={`New event in ${where} for ${address}`}
                    >
                      New event{several ? ` · ${address}` : ''} <span aria-hidden="true">↗</span>
                    </Button>
                  );
                })}
              </ButtonGroup>
            )}
            <Keys />
          </div>
        }
        className="flex flex-col"
      >
        <SectionProjectFilter items={state.forProjectFilter} />
        <div className="flex h-11 items-center border-b border-line">
          <div className="ml-[41px] flex items-center gap-3">
            <ButtonGroup>
              <Button size="icon" aria-label="Back ([)" title="Back ([)" onClick={() => state.step(-1)}>
                <span aria-hidden="true">‹</span>
              </Button>
              <Button onClick={state.goToday} title="Today (T)">
                Today
              </Button>
              <Button size="icon" aria-label="Forward (])" title="Forward (])" onClick={() => state.step(1)}>
                <span aria-hidden="true">›</span>
              </Button>
            </ButtonGroup>
            <h3
              data-testid="calendar-range"
              className="m-0 font-mono text-label-lg leading-none font-semibold uppercase tracking-caps whitespace-nowrap text-ink"
            >
              {range}
            </h3>
          </div>
          <p
            data-testid="calendar-sync-status"
            role="status"
            className={cn(
              'm-0 ml-auto flex min-w-0 items-center gap-2 px-4 text-right font-mono text-label leading-tight uppercase tracking-label',
              status.problem ? 'font-semibold text-ink' : 'font-medium text-faint',
            )}
          >
            {syncing && <Led size="sm" />}
            <span className="truncate">{status.text}</span>
          </p>
        </div>
        {outside && (
          <p
            data-testid="calendar-outside"
            className="hatch m-0 border-b border-line2 py-2 pr-5 pl-13 text-note text-muted"
          >
            {state.outside.before && state.outside.after
              ? 'Events this far back or ahead aren’t kept in Commander'
              : state.outside.before
                ? 'Older events aren’t kept in Commander'
                : 'Events this far ahead aren’t kept in Commander'}
            {providers.length > 0 && (
              <>
                {'. They live in '}
                {providers.map((provider, index) => (
                  <span key={provider.name}>
                    {index > 0 && ' and '}
                    <a
                      href={provider.url}
                      onClick={(click) => {
                        click.preventDefault();
                        open(provider.url);
                      }}
                      className="text-ink underline decoration-line underline-offset-2 hover:decoration-ink"
                    >
                      {provider.name} ↗
                    </a>
                  </span>
                ))}
              </>
            )}
            .
          </p>
        )}
        {state.loaded && state.accounts.length === 0 && total === 0 && view === 'agenda' ? (
          <EmptySheet>
            No calendar connected yet. Connect a Google or Outlook Account in{' '}
            <SettingsLink to={{ group: 'accounts' }}>Settings → Accounts</SettingsLink>.
          </EmptySheet>
        ) : (
          <PickBadgeProvider value={badges.open}>
            <div
              className={cn(
                'flex-1',
                detailOpen &&
                  (view === 'agenda'
                    ? 'grid grid-cols-[minmax(0,9fr)_minmax(0,7fr)]'
                    : 'grid grid-cols-[minmax(0,5fr)_minmax(0,3fr)]'),
              )}
            >
              {view === 'week' || view === 'day' ? (
                <TimeGrid
                  days={state.shownDays}
                  events={state.filtered}
                  timeZone={timeZone}
                  secondTimeZone={secondTimeZone}
                  now={now.getTime()}
                  today={state.today}
                  clashes={state.clashes}
                  selectedId={selectedId}
                  onOpen={openEntry}
                  overlay={(day, top) => (
                    <FocusSuggestionBlocks
                      blocks={focus.byDay.get(day)}
                      focus={focus}
                      timeZone={timeZone}
                      top={top}
                    />
                  )}
                />
              ) : view === 'month' ? (
                <MonthGrid
                  days={state.shownDays}
                  anchor={state.anchor}
                  today={state.today}
                  events={state.filtered}
                  timeZone={timeZone}
                  clashes={state.clashes}
                  selectedId={selectedId}
                  onOpen={openEntry}
                  onShowDay={state.showDay}
                />
              ) : (
                <div className="min-w-0 pb-30" data-testid="agenda">
                  {agendaWithFocus.map((day, index) => (
                    <TodoGroup
                      key={day.day}
                      no={`D${pad(index + 1)}`}
                      title={day.title}
                      count={day.entries.length}
                    >
                      {day.entries.length ? (
                        <ul className="m-0 list-none p-0">
                          {day.entries.map((entry) => (
                            <EventRow
                              key={`${entry.day}/${entry.event.id}`}
                              entry={entry}
                              selected={entry === selectedEntry}
                              account={
                                several && entry.event.account
                                  ? (emailOf.get(entry.event.account) ?? null)
                                  : null
                              }
                              compact={detailOpen}
                              clashes={state.clashes.get(entry.event.id) ?? []}
                              answer={
                                invites.enabled && (
                                  <>
                                    <RowAnswer
                                      event={entry.event}
                                      sync={invites.syncOf(entry.event.id)}
                                      onAnswer={(answer) => void invites.answer(entry.event, answer)}
                                    />
                                    <RowSync event={entry.event} sync={invites.syncOf(entry.event.id)} />
                                  </>
                                )
                              }
                              suggestion={(() => {
                                const reply = invites.suggestions.get(entry.event.id);
                                return reply ? (
                                  <SuggestedReplyCard
                                    compact
                                    reply={reply}
                                    onSend={() => void invites.send(reply)}
                                    onDismiss={() => void invites.dismiss(reply)}
                                  />
                                ) : null;
                              })()}
                              onOpen={() => openEntry(entry)}
                            />
                          ))}
                        </ul>
                      ) : focus.byDay.has(day.day) ? null : (
                        <p className="hatch m-0 border-b border-line2 py-2.5 pr-5 pl-13 text-note text-faint">
                          {day.day === state.today ? 'Nothing on today.' : 'Nothing on this day.'}
                        </p>
                      )}
                      <FocusSuggestionRows
                        blocks={focus.byDay.get(day.day)}
                        focus={focus}
                        timeZone={timeZone}
                      />
                    </TodoGroup>
                  ))}
                  {state.canShowMore && (
                    <div className="mt-6 mr-5 ml-13">
                      <Button onClick={state.showMore}>Show more days</Button>
                    </div>
                  )}
                </div>
              )}
              {detailOpen && (
                <EventDetail
                  event={selected}
                  editUrl={selected ? editUrl(selected) : null}
                  timeZone={timeZone}
                  secondTimeZone={secondTimeZone}
                  clashes={selected ? (state.clashes.get(selected.id) ?? []) : []}
                  links={state.links}
                  history={state.history}
                  onEdit={(url) => handOff(url, selected?.account ?? null)}
                  onFile={file}
                  onClose={() => setDetailOpen(false)}
                  onOpenLink={openLink}
                  Prep={Prep}
                  invitation={
                    selected &&
                    invites.enabled && (
                      <>
                        <InvitationPanel
                          event={selected}
                          reply={invites.suggestions.get(selected.id) ?? null}
                          sync={invites.syncOf(selected.id)}
                          note={supersededNote(state.history)}
                          onAnswer={(answer, series) => void invites.answer(selected, answer, series)}
                          onSend={(reply) => void invites.send(reply)}
                          onDismiss={(reply) => void invites.dismiss(reply)}
                          onRetry={() => void invites.retry(selected.id)}
                        />
                        {/* An edit of an event Commander made (#206): Couldn't sync with Retry too. */}
                        <EventSync
                          event={selected}
                          sync={invites.syncOf(selected.id)}
                          onRetry={() => void invites.retry(selected.id)}
                        />
                      </>
                    )
                  }
                />
              )}
            </div>
          </PickBadgeProvider>
        )}
        {badges.picker}
      </SectionSheet>
      <aside className="relative col-span-2 min-w-0" aria-label="Calendars">
        <div className="sticky top-(--body) mr-4 ml-3.5 flex max-h-[calc(100vh-var(--body))] flex-col gap-3.5 overflow-auto pt-3.5 pb-6 [scrollbar-width:none]">
          {autonomy && <FocusTimePanel focus={focus} timeZone={timeZone} />}
          <SideCard label="Calendars" title="Calendars" note={pad(state.calendars.length)}>
            {state.calendars.length ? (
              <ul className="m-0 list-none p-0" data-testid="calendar-list">
                {calendarGroups.map(({ account, calendars }) => (
                  <li
                    key={account.id}
                    data-testid="calendar-group"
                    className="border-b border-line2 last:border-b-0"
                  >
                    {several && (
                      <p className="m-0 truncate px-2.5 pt-2 font-mono text-label leading-tight uppercase tracking-label text-muted">
                        {addressOf(account)}
                        <span className="text-faint">
                          {' · '}
                          {account.source === 'google' ? 'Google' : 'Outlook'}
                        </span>
                      </p>
                    )}
                    <ul className="m-0 list-none p-0" aria-label={`Calendars of ${addressOf(account)}`}>
                      {calendars.map((calendar) => {
                        const shown = !state.hidden.has(keyOfCalendar(calendar));
                        return (
                          <li
                            key={keyOfCalendar(calendar)}
                            className="flex min-h-9 items-center gap-2.5 border-b border-line2 px-2.5 last:border-b-0"
                          >
                            <CalendarSwatch colour={calendar.colour} />
                            <span className="min-w-0 flex-1 truncate text-note text-ink">
                              {calendar.name}
                            </span>
                            <Switch
                              aria-label={`Show ${calendar.name}`}
                              checked={shown}
                              onCheckedChange={(on) => state.setCalendarShown(calendar, on)}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 px-2.5 py-2 text-note text-faint">
                No calendars yet. Calendars switched on in{' '}
                <SettingsLink to={{ group: 'accounts' }}>Settings → Accounts</SettingsLink> show here.
              </p>
            )}
          </SideCard>
        </div>
      </aside>
    </>
  );
}
