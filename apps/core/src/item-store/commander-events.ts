// Events Commander writes (the domain's commander-events.ts) in the Item store: a focus block, a busy
// copy or a meeting with guests (#132, on the calendar chosen, the User its organiser) is made as an `event` Item at once, under a placeholder external id, and its creation queued for
// the Source as the outgoing change `create`, in one transaction (ADR 0003, as Send to Linear does). The
// sync engine sends it; the Source's answer (or a sync that gets there first) names the Item, which then
// takes its real external id. Each busy copy is recorded against the event it copies, so it is made
// once per event and Account, follows its event, and is never itself copied.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type ActivityEntry,
  type Actor,
  BUSY_COPY_TITLE,
  type CausedBy,
  COMMANDER_CALENDAR_NAME,
  type CommanderEventCreate,
  type CommanderEventDraft,
  type CommanderEventMove,
  CREATE_FIELD,
  commanderEventDraft,
  commanderEventMove,
  DELETE_FIELD,
  type EventCalendar,
  type EventDetail,
  type Item,
  type ItemState,
  MOVE_FIELD,
  pendingEventExternalId,
  type Source,
} from '@commander/domain';
import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { CalendarStore } from './calendars';
import type { OutgoingQueue } from './outgoing';
import * as schema from './schema';

type Entry = { by: Actor; why?: string | null; causedBy?: CausedBy | null };

// The calendar a focus block shows on until the Commander calendar is known (made on first use).
export const PENDING_COMMANDER_CALENDAR: EventCalendar = {
  id: 'commander',
  name: COMMANDER_CALENDAR_NAME,
  colour: '#7986cb',
};

export type BusyCopy = { eventId: string; targetAccount: string; copyId: string };

export type BusyCopies = {
  // Every busy copy Commander made, oldest first.
  list(): BusyCopy[];
};

export type CommanderEventsDeps = {
  db: BetterSQLite3Database<typeof schema>;
  calendars: CalendarStore;
  readItem(id: string): Item | undefined;
  // Inserts the event's Item under the id given (as `insertItem`), returning its state as stored.
  insert(
    identity: Pick<Item, 'kind' | 'source' | 'account' | 'externalId'>,
    state: ItemState,
    at: number,
    chosenId: string,
  ): { id: string; state: ItemState };
  log(
    entry: Entry & { action: 'create'; itemId: string; before: null; after: ItemState },
    at: number,
  ): ActivityEntry;
  outgoing: OutgoingQueue;
  checkFiling(filing: ItemState['filing']): void;
  invalid(message: string): Error;
};

export function commanderEventsIn(deps: CommanderEventsDeps) {
  const { db } = deps;
  const { busyCopies: table } = schema;

  return {
    /** Makes the event's Item and queues its creation. Runs inside a transaction. */
    create(input: CommanderEventDraft, entry: Entry, at: number): ActivityEntry {
      const parsed = commanderEventDraft.safeParse(input);
      if (!parsed.success) throw deps.invalid(parsed.error.issues[0]?.message ?? 'That event can’t be made');
      const draft = parsed.data;
      if (draft.end.at <= draft.start.at) throw deps.invalid('An event ends after it starts');
      const listed = deps.calendars.list(draft.account);
      const first = listed[0];
      if (!first) {
        throw deps.invalid(
          'Commander hasn’t seen that Account’s calendars yet: try again once it has synced',
        );
      }
      const source: Source = first.source;
      const primary = listed.find((calendar) => calendar.primary) ?? null;

      let calendar: EventCalendar;
      let calendarId: string | null;
      if (draft.kind === 'meeting') {
        // On the calendar chosen, or the Account's main calendar; one the User can add events to.
        const chosen = draft.calendarId ? listed.find((each) => each.id === draft.calendarId) : primary;
        if (!chosen) {
          throw deps.invalid(
            draft.calendarId
              ? 'That Account doesn’t have the calendar chosen for this event'
              : 'Commander doesn’t know that Account’s main calendar yet',
          );
        }
        if (chosen.accessRole !== 'owner' && chosen.accessRole !== 'writer') {
          throw deps.invalid(`You can’t add events to “${chosen.name}”`);
        }
        calendar = { id: chosen.id, name: chosen.name, colour: chosen.colour };
        calendarId = chosen.id;
        if (draft.filing) deps.checkFiling(draft.filing);
      } else if (draft.kind === 'focus-block') {
        // The Commander calendar, if a sync has listed it; otherwise the adapter finds or makes it.
        const found = listed.find(
          (each) => each.name === COMMANDER_CALENDAR_NAME && each.accessRole === 'owner',
        );
        calendar = found
          ? { id: found.id, name: found.name, colour: found.colour }
          : PENDING_COMMANDER_CALENDAR;
        calendarId = found?.id ?? null;
        if (draft.filing) deps.checkFiling(draft.filing);
      } else {
        if (!draft.copyOf || !deps.readItem(draft.copyOf)) throw deps.invalid('A busy copy copies an event');
        if (!primary) throw deps.invalid('Commander doesn’t know that Account’s main calendar yet');
        const made = db
          .select()
          .from(table)
          .where(and(eq(table.eventId, draft.copyOf), eq(table.targetAccount, draft.account)))
          .get();
        if (made) throw deps.invalid('That event already has a busy copy there');
        calendar = { id: primary.id, name: primary.name, colour: primary.colour };
        calendarId = primary.id;
      }

      const title = draft.kind === 'busy-block' ? BUSY_COPY_TITLE : draft.title;
      // Google names a primary calendar after its Account's address.
      const accountEmail = source === 'google-calendar' ? (primary?.id ?? null) : null;
      const meeting = draft.kind === 'meeting';
      // A meeting's guests, once each; until the Source answers, the User is its organiser.
      const guests = meeting
        ? [...new Map(draft.attendees.map((guest) => [guest.email, guest])).values()]
        : [];
      const detail: EventDetail = {
        kind: 'event',
        calendar,
        accountEmail,
        start: draft.start,
        end: draft.end,
        allDay: draft.allDay,
        location: null,
        description: null,
        organiser: meeting && accountEmail ? { email: accountEmail, name: null, self: true } : null,
        attendees: guests.map((guest) => ({
          email: guest.email,
          name: guest.name,
          self: false,
          response: 'needs-action' as const,
          organiser: false,
          optional: false,
          resource: false,
        })),
        myResponse: null,
        meetingUrl: null,
        busy: true,
        private: !meeting,
        seriesId: null,
        webUrl: null,
        createdByCommander: draft.kind,
      };
      const id = randomUUID();
      const externalId = pendingEventExternalId(id);
      const { state } = deps.insert(
        { kind: 'event', source, account: draft.account, externalId },
        {
          title,
          people: guests.map((guest) => guest.email),
          status: 'open',
          filing: draft.kind === 'busy-block' ? null : (draft.filing ?? null),
          detail,
          deletedAt: null,
        },
        at,
        id,
      );
      const created = deps.log({ ...entry, action: 'create', itemId: id, before: null, after: state }, at);
      const value: CommanderEventCreate = {
        kind: draft.kind,
        calendarId,
        commanderId: id,
        title,
        start: draft.start,
        end: draft.end,
        allDay: draft.allDay,
        attendees: guests,
      };
      deps.outgoing.queue({
        account: draft.account,
        source,
        itemId: id,
        externalId,
        field: CREATE_FIELD,
        value,
        synced: null,
        madeAt: at,
        entryId: created.id,
      });
      if (draft.kind === 'busy-block' && draft.copyOf) {
        db.insert(table)
          .values({ eventId: draft.copyOf, targetAccount: draft.account, copyId: id, createdAt: at })
          .run();
      }
      return created;
    },

    busyCopies: {
      list: () =>
        db
          .select({ eventId: table.eventId, targetAccount: table.targetAccount, copyId: table.copyId })
          .from(table)
          .orderBy(table.createdAt)
          .all(),
    } satisfies BusyCopies,
  };
}

// Whether an Item is an event Commander made, at a Source (or on its way there).
const isCommanderEvent = (item: Item, state: ItemState) =>
  item.kind === 'event' &&
  !!item.source &&
  !!item.account &&
  !!item.externalId &&
  state.detail?.kind === 'event' &&
  state.detail.createdByCommander !== null;

/**
 * Queues for the Source what a change made in Commander (not by the Source) did to an event Commander
 * made: moved, it queues `time` (start and end together); deleted, `delete`. Undoing its creation is
 * queued by the Item store's undo, as for every Source Item made in Commander.
 */
export function queueCommanderEventChanges(
  queue: OutgoingQueue,
  item: Item,
  before: ItemState,
  after: ItemState,
  entry: ActivityEntry,
) {
  if (entry.by.kind === 'source' || !isCommanderEvent(item, before)) return;
  const was = before.detail?.kind === 'event' ? before.detail : null;
  const now = after.detail?.kind === 'event' ? after.detail : null;
  const base = {
    account: item.account as string,
    source: item.source as Source,
    itemId: item.id,
    externalId: item.externalId as string,
    synced: null,
    madeAt: entry.at,
    entryId: entry.id,
  };
  if (was && now && after.deletedAt === null) {
    const move: CommanderEventMove = { start: now.start, end: now.end, allDay: now.allDay };
    const moved =
      !isDeepStrictEqual(was.start, now.start) ||
      !isDeepStrictEqual(was.end, now.end) ||
      was.allDay !== now.allDay;
    // The time it had kept with the change (the Source's, unless an earlier move is still queued, which
    // keeps its own): moving it back drops the change, and Discard (#206) puts it back there.
    const kept: CommanderEventMove = { start: was.start, end: was.end, allDay: was.allDay };
    if (moved) queue.queue({ ...base, field: MOVE_FIELD, value: move, synced: kept });
  }
  if (entry.action === 'delete' && before.deletedAt === null && after.deletedAt !== null) {
    queue.queue({ ...base, field: DELETE_FIELD, value: true });
  }
}

/** The event's new detail, checked: only an event Commander made can be moved from Commander. */
export function movedDetail(
  item: Item,
  input: CommanderEventMove,
  invalid: (message: string) => Error,
): EventDetail {
  const move = commanderEventMove.parse(input);
  if (item.detail?.kind !== 'event' || item.detail.createdByCommander === null) {
    throw invalid('Commander moves only the events Commander made');
  }
  if (move.end.at <= move.start.at) throw invalid('An event ends after it starts');
  return { ...item.detail, start: move.start, end: move.end, allDay: move.allDay };
}
