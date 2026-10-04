import { Button, ButtonGroup, cn, Kbd, Led, Switch } from '@commander/ui';
import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { useReveal } from '../../frame/reveal';
import { useNow } from '../../frame/use-now';
import { PickBadgeProvider, useBadgePicker } from '../../projects/BadgePicker';
import { SectionProjectFilter } from '../../projects/badges';
import { useProjectFilter, useProjects } from '../../projects/context';
import { SideCard } from '../../projects/page/SideCard';
import { useShortcuts } from '../../shortcuts/react';
import { EmptySheet, SectionSheet, useOpenSection, useSection, useTabCount } from '../section';
import { sectionFor } from '../todos/links';
import { TodoGroup } from '../todos/TodoGroup';
import { editUrl, newEventUrl } from './agenda';
import {
  type CalendarAccountsClient,
  type CalendarEvents,
  calendarSyncLine,
  calendarSyncOf,
  type EventLink,
} from './calendar-events';
import { EventDetail } from './EventDetail';
import { CalendarSwatch, EventRow } from './EventRow';
import { keyOfCalendar, useCalendar } from './use-calendar';

// Enter opens the selected event, except on a control that Enter presses (a button, a link).
const onPressable = () => !!document.activeElement?.closest('button, a[href], summary, [role="button"]');

const KEYS: [ReactNode, string][] = [
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

const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const openInBrowser = (url: string) => {
  window.open(url, '_blank', 'noopener,noreferrer');
};

/**
 * The Calendar Section's sheet: the sheet header, the Project filter, the sync status line, then the
 * Agenda (today first, each day's events in time order, all-day ones at the top) and, once an event
 * is opened, its detail pane. A side column lists every calendar, to show or hide each in this view.
 * Opening the Section asks every Google Account to sync its calendars; Edit and New event open
 * Google Calendar in the browser, and the Account is synced again when the window regains focus.
 */
export function CalendarSheet({
  events,
  accounts,
  timeZone = systemTimeZone(),
  open = openInBrowser,
}: {
  events: CalendarEvents;
  accounts: CalendarAccountsClient;
  /** The User's time zone (the machine's), which the Agenda's days follow. */
  timeZone?: string;
  /** Opens an address in the system browser. */
  open?: (url: string) => void;
}) {
  const { filter, include } = useProjectFilter();
  const { projects, openPage } = useProjects();
  const filtered = projects.find((project) => project.id === filter);
  const now = useNow(60_000);
  const state = useCalendar({ events, accounts, include, now: now.getTime(), timeZone });
  const { selected, selectedEntry, detailOpen, setDetailOpen } = state;
  const badges = useBadgePicker(state.apply, state.undo);
  const openSection = useOpenSection();
  const several = state.accounts.length > 1;
  const { active } = useSection();

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
    selected && badges.open({ id: selected.id, title: selected.title, filing: selected.filing });

  const openLink = ({ other }: EventLink) => {
    if (other.kind === 'project') return openPage?.(other.id);
    if (other.deletedAt !== null) return;
    const section = sectionFor(other.kind);
    if (section && section !== 'calendar') openSection(section);
    else if (other.kind === 'event') void state.reveal(other.id);
  };

  useShortcuts([
    { keys: 'j', label: 'Next event', run: () => state.moveSelection(1) },
    { keys: 'k', label: 'Previous event', run: () => state.moveSelection(-1) },
    { keys: 'Enter', label: 'Open the event', when: () => !onPressable(), run: () => setDetailOpen(true) },
    { keys: 'Escape', label: 'Close the event', when: () => detailOpen, run: () => setDetailOpen(false) },
    { keys: 'b', label: 'File under a Project', run: () => file() },
    { keys: 'Ctrl+z', label: 'Undo', run: () => void state.undo() },
  ]);
  // From the palette: open an event it found.
  useReveal('calendar', (itemId) => void state.reveal(itemId));

  const status = calendarSyncLine(state.accounts, now);
  const syncing = state.accounts.some((account) => calendarSyncOf(account)?.activity === 'syncing');
  const emailOf = new Map(state.accounts.map((account) => [account.id, account.email]));
  const total = state.entries.length;

  return (
    <>
      <SectionSheet
        span="wide"
        subtitle={
          <>
            <b>{state.toCome} still to come today</b>
            {filter !== 'everything' && ` ${filtered ? `in ${filtered.name}` : 'Unfiled'}`}
            {` · ${total} in the next ${state.days} days`}
          </>
        }
        aside={
          <div className="flex items-end gap-5">
            {state.accounts.length > 0 && (
              <ButtonGroup>
                {state.accounts.map((account) => (
                  <Button
                    key={account.id}
                    onClick={() => handOff(newEventUrl(account.email), account.id)}
                    title={`New event in Google Calendar for ${account.email}`}
                  >
                    New event{several ? ` · ${account.email}` : ''} <span aria-hidden="true">↗</span>
                  </Button>
                ))}
              </ButtonGroup>
            )}
            <Keys />
          </div>
        }
        className="flex flex-col"
      >
        <SectionProjectFilter items={state.forProjectFilter} />
        <div className="flex h-9 items-center border-b border-line">
          <span className="px-13 font-mono text-label leading-none font-semibold uppercase tracking-caps text-ink">
            Agenda
          </span>
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
        {state.loaded && state.accounts.length === 0 && total === 0 ? (
          <EmptySheet>
            No Google Calendar connected yet. Connect a Google Account in Settings → Accounts (,).
          </EmptySheet>
        ) : (
          <PickBadgeProvider value={badges.open}>
            <div className={cn('flex-1', detailOpen && 'grid grid-cols-[minmax(0,9fr)_minmax(0,7fr)]')}>
              <div className="min-w-0 pb-30" data-testid="agenda">
                {state.agenda.map((day, index) => (
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
                            onOpen={() => {
                              state.select(entry);
                              setDetailOpen(true);
                            }}
                          />
                        ))}
                      </ul>
                    ) : (
                      <p className="hatch m-0 border-b border-line2 py-2.5 pr-5 pl-13 text-note text-faint">
                        Nothing on today.
                      </p>
                    )}
                  </TodoGroup>
                ))}
                {state.canShowMore && (
                  <div className="mt-6 mr-5 ml-13">
                    <Button onClick={state.showMore}>Show more days</Button>
                  </div>
                )}
              </div>
              {detailOpen && (
                <EventDetail
                  event={selected}
                  editUrl={selected ? editUrl(selected) : null}
                  timeZone={timeZone}
                  links={state.links}
                  history={state.history}
                  onEdit={(url) => handOff(url, selected?.account ?? null)}
                  onFile={file}
                  onClose={() => setDetailOpen(false)}
                  onOpenLink={openLink}
                />
              )}
            </div>
          </PickBadgeProvider>
        )}
        {badges.picker}
      </SectionSheet>
      <aside className="relative col-span-2 min-w-0" aria-label="Calendars">
        <div className="sticky top-(--body) mr-4 ml-3.5 flex max-h-[calc(100vh-var(--body))] flex-col gap-3.5 overflow-auto pt-3.5 pb-6 [scrollbar-width:none]">
          <SideCard label="Calendars" title="Calendars" note={pad(state.calendars.length)}>
            {state.calendars.length ? (
              <ul className="m-0 list-none p-0" data-testid="calendar-list">
                {state.calendars.map((calendar) => {
                  const shown = !state.hidden.has(keyOfCalendar(calendar));
                  return (
                    <li
                      key={keyOfCalendar(calendar)}
                      className="flex min-h-9 items-center gap-2.5 border-b border-line2 px-2.5 last:border-b-0"
                    >
                      <CalendarSwatch colour={calendar.colour} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-note text-ink">{calendar.name}</span>
                        {several && (
                          <span className="block truncate text-label text-muted">
                            {emailOf.get(calendar.account)}
                          </span>
                        )}
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
            ) : (
              <p className="m-0 px-2.5 py-2 text-note text-faint">
                No calendars yet. Calendars switched on in Settings → Accounts show here.
              </p>
            )}
          </SideCard>
        </div>
      </aside>
    </>
  );
}
