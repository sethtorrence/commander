import type { ActivityEntry, CalendarSummary, Item } from '@commander/domain';
import type { GoogleAccountSummary } from '@commander/domain/ipc';
import { toast } from '@commander/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AgendaDay,
  type AgendaEntry,
  addDays,
  agendaDays,
  type CalendarEvent,
  dayKey,
  dayStart,
  daysOf,
  stillToCome,
} from './agenda';
import {
  type CalendarAccountsClient,
  type CalendarEvents,
  calendarSyncOf,
  type EventLink,
} from './calendar-events';

/*
  The Calendar Section's state: the calendar Accounts and their calendars, the events in the days
  shown, which calendars this view hides, the selection and the detail pane, and filing with undo.
*/

export const HIDDEN_STORAGE_KEY = 'commander.calendar.hidden';
// Days the Agenda shows at first, and how many more each "Show more days" adds.
export const AGENDA_DAYS = 30;
const MOST_DAYS = 365;

const calendarKey = (account: string | null, calendarId: string) => `${account ?? ''}/${calendarId}`;
export const keyOfCalendar = (calendar: Pick<CalendarSummary, 'account' | 'id'>) =>
  calendarKey(calendar.account, calendar.id);
export const keyOfEvent = (event: CalendarEvent) => calendarKey(event.account, event.detail.calendar.id);
const entryKey = (entry: AgendaEntry) => `${entry.day}/${entry.event.id}`;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

function loadHidden(storage: Storage): Set<string> {
  try {
    const saved = JSON.parse(storage.getItem(HIDDEN_STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(saved) ? saved.filter((each) => typeof each === 'string') : []);
  } catch {
    return new Set();
  }
}

// What changes when an Account syncs, so the events are read again.
const syncSignature = (accounts: readonly GoogleAccountSummary[]) =>
  accounts
    .map((account) => {
      const sync = calendarSyncOf(account);
      return `${account.id}:${sync?.lastSyncedAt ?? ''}:${sync?.activity ?? ''}`;
    })
    .join('|');

const report = (error: unknown) => toast(error instanceof Error ? error.message : String(error));

export function useCalendar({
  events: client,
  accounts: accountsClient,
  include,
  now,
  timeZone,
  storage = localStorage,
}: {
  events: CalendarEvents;
  accounts: CalendarAccountsClient;
  include: (item: Pick<Item, 'filing'>) => boolean;
  now: number;
  timeZone: string;
  storage?: Storage;
}) {
  const [known, setAccounts] = useState<GoogleAccountSummary[] | null>(null);
  const accounts = useMemo(() => known ?? [], [known]);
  const [calendars, setCalendars] = useState<CalendarSummary[]>([]);
  const [items, setItems] = useState<CalendarEvent[] | null>(null);
  const [days, setDays] = useState(AGENDA_DAYS);
  const [hidden, setHidden] = useState<Set<string>>(() => loadHidden(storage));
  // An entry (`<day>/<id>`), or `event:<id>` for an event opened from elsewhere (its first entry).
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<CalendarEvent | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [history, setHistory] = useState<ActivityEntry[]>([]);
  const [links, setLinks] = useState<EventLink[]>([]);
  const [version, setVersion] = useState(0);
  const undoable = useRef<number[]>([]);
  const lastIndex = useRef(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  const today = dayKey(now, timeZone);
  const from = dayStart(today, timeZone);
  const to = dayStart(addDays(today, days), timeZone);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload
  useEffect(() => {
    let current = true;
    client.list(from, to).then((next) => current && setItems(next), report);
    client.calendars().then((next) => current && setCalendars(next), report);
    return () => {
      current = false;
    };
  }, [client, from, to, version]);

  // The Accounts, kept current; the events are read again whenever a sync finishes.
  const synced = useRef<string | null>(null);
  useEffect(() => {
    let current = true;
    const take = (next: GoogleAccountSummary[]) => {
      if (!current) return;
      setAccounts(next);
      const signature = syncSignature(next);
      if (synced.current !== null && synced.current !== signature) reload();
      synced.current = signature;
    };
    accountsClient.list().then(take, report);
    const stop = accountsClient.onChange(take);
    return () => {
      current = false;
      stop();
    };
  }, [accountsClient, reload]);

  // Every Account's Google Calendar (or just these Accounts'), synced at once: on opening the Section,
  // and on coming back from Google Calendar. Asked for before the Accounts are read, it waits for them.
  const [refreshWanted, setRefreshWanted] = useState(false);
  const refresh = useCallback(
    (only?: readonly string[]) => {
      if (known === null) {
        setRefreshWanted(true);
        return;
      }
      for (const account of known) {
        if (!only || only.includes(account.id)) accountsClient.refresh(account.id).catch(report);
      }
    },
    [known, accountsClient],
  );
  useEffect(() => {
    if (!refreshWanted || known === null) return;
    setRefreshWanted(false);
    for (const account of known) accountsClient.refresh(account.id).catch(report);
  }, [refreshWanted, known, accountsClient]);

  // Calendars of Accounts no longer connected (or with Google Calendar off) aren't listed.
  const listed = useMemo(() => {
    const ids = new Set(accounts.map((account) => account.id));
    return calendars.filter((calendar) => calendar.on && ids.has(calendar.account));
  }, [calendars, accounts]);
  // Events of Accounts no longer syncing Google Calendar (switched off in Settings) aren't shown.
  const all = useMemo(() => {
    const ids = new Set(accounts.map((account) => account.id));
    return (items ?? []).filter((event) => event.account !== null && ids.has(event.account));
  }, [items, accounts]);
  const shownEvents = useMemo(() => all.filter((event) => !hidden.has(keyOfEvent(event))), [all, hidden]);
  const filtered = useMemo(() => shownEvents.filter(include), [shownEvents, include]);
  const agenda: AgendaDay[] = useMemo(
    () => agendaDays(filtered, { today, days, timeZone }),
    [filtered, today, days, timeZone],
  );
  const entries = useMemo(() => agenda.flatMap((day) => day.entries), [agenda]);
  // The Project filter counts the events in the days shown, whatever it is set to.
  const forProjectFilter = useMemo(() => {
    const inDays = new Set(
      agendaDays(shownEvents, { today, days, timeZone }).flatMap((day) => day.entries.map((e) => e.event.id)),
    );
    return shownEvents.filter((event) => inDays.has(event.id));
  }, [shownEvents, today, days, timeZone]);
  const toCome = useMemo(() => stillToCome(shownEvents, now, timeZone), [shownEvents, now, timeZone]);

  const askedFor = selectedKey?.startsWith('event:') ? selectedKey.slice('event:'.length) : null;
  const wanted = askedFor ?? (selectedKey ? selectedKey.slice(selectedKey.lastIndexOf('/') + 1) : null);
  const selectedEntry =
    entries.find((entry) => entryKey(entry) === selectedKey) ??
    (askedFor ? entries.find((entry) => entry.event.id === askedFor) : undefined) ??
    (wanted && detailOpen ? undefined : entries[Math.min(lastIndex.current, entries.length - 1)]) ??
    null;
  // An event open in the detail pane stays open even when it isn't in the list (filing it moved it
  // out of the Project filter, or the palette opened one from the past).
  const selected: CalendarEvent | null =
    selectedEntry?.event ??
    (detailOpen && wanted
      ? (all.find((event) => event.id === wanted) ?? (revealed?.id === wanted ? revealed : null))
      : null);
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    const index = selectedEntry ? entries.indexOf(selectedEntry) : -1;
    if (index >= 0) lastIndex.current = index;
  }, [selectedEntry, entries]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload after a change
  useEffect(() => {
    if (!selectedId) {
      setHistory([]);
      setLinks([]);
      return;
    }
    let current = true;
    client.history(selectedId).then((next) => current && setHistory(next), report);
    client.links(selectedId).then((next) => current && setLinks(next), report);
    return () => {
      current = false;
    };
  }, [client, selectedId, version]);

  const moveSelection = useCallback(
    (step: 1 | -1) => {
      if (!entries.length) return;
      const index = selectedEntry ? entries.indexOf(selectedEntry) : -1;
      const next = entries[Math.min(entries.length - 1, Math.max(0, index + step))];
      if (next) setSelectedKey(entryKey(next));
    },
    [entries, selectedEntry],
  );

  const select = useCallback((entry: AgendaEntry) => setSelectedKey(entryKey(entry)), []);

  const setCalendarShown = useCallback(
    (calendar: Pick<CalendarSummary, 'account' | 'id'>, shown: boolean) => {
      setHidden((now) => {
        const next = new Set(now);
        if (shown) next.delete(keyOfCalendar(calendar));
        else next.add(keyOfCalendar(calendar));
        try {
          storage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify([...next]));
        } catch {
          // Storage unavailable: the choice still applies for this session.
        }
        return next;
      });
    },
    [storage],
  );

  // From the palette: show an event, wherever it is (its calendar shown, its day loaded, if it is
  // still to come within the year).
  const reveal = useCallback(
    async (itemId: string) => {
      const event = all.find((each) => each.id === itemId) ?? (await client.get(itemId).catch(() => null));
      if (event) {
        if (hidden.has(keyOfEvent(event))) {
          setCalendarShown({ account: event.account ?? '', id: event.detail.calendar.id }, true);
        }
        const first = daysOf(event, timeZone).find((day) => day >= today);
        if (first) setDays((now) => Math.min(MOST_DAYS, Math.max(now, daysBetween(today, first) + 1)));
        setRevealed(event);
      }
      setSelectedKey(`event:${itemId}`);
      setDetailOpen(true);
      reload();
    },
    [all, client, hidden, reload, setCalendarShown, timeZone, today],
  );

  const apply = useCallback(
    async (change: () => Promise<ActivityEntry>) => {
      try {
        const entry = await change();
        undoable.current.push(entry.id);
        reload();
        return entry;
      } catch (error) {
        report(error);
        return null;
      }
    },
    [reload],
  );

  const undo = useCallback(
    async (entryId?: number) => {
      const target = entryId ?? undoable.current.at(-1);
      if (target === undefined) {
        toast('Nothing to undo here');
        return;
      }
      undoable.current = undoable.current.filter((id) => id !== target);
      try {
        await client.undo(target);
      } catch (error) {
        report(error);
      }
      reload();
    },
    [client, reload],
  );

  return {
    loaded: items !== null && known !== null,
    accounts,
    calendars: listed,
    hidden,
    setCalendarShown,
    agenda,
    entries,
    forProjectFilter,
    toCome,
    days,
    canShowMore: days < MOST_DAYS,
    showMore: () => setDays((now) => Math.min(MOST_DAYS, now + AGENDA_DAYS)),
    selected,
    selectedEntry,
    select,
    moveSelection,
    detailOpen,
    setDetailOpen,
    history,
    links,
    reveal,
    refresh,
    reload,
    apply,
    undo,
  };
}

export type CalendarState = ReturnType<typeof useCalendar>;
