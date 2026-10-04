// Calendars in the Item store: each calendar Account's calendars as its last sync listed them, the
// User's switch for each, and what the Calendar Section asks of the events (a time range, earliest
// first). It shares the Item store's database, so the Item store stays its only writer. Switching a
// calendar off (which also hides its events) is the Item store's own action, as it changes Items.
import {
  type CalendarSummary,
  calendarOnByDefault,
  type EventQuery,
  eventQuery,
  type Source,
} from '@commander/domain';
import { and, asc, eq, gt, gte, inArray, isNull, lt, notInArray, or } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { ItemRow } from './rows';
import * as schema from './schema';

// A calendar as a sync lists it.
export type ListedCalendar = {
  id: string;
  name: string;
  colour: string;
  primary: boolean;
  accessRole: string;
};

export type CalendarStore = {
  // The calendars the Account lists now, in its order: new ones are added (with their default),
  // gone ones dropped, the User's switches kept. Answers the ids of those on.
  listed(account: string, source: Source, calendars: readonly ListedCalendar[]): Set<string>;
  // Every Account's calendars (or one Account's), each Account's in its order.
  list(account?: string): CalendarSummary[];
  // The calendar, if the Account lists it.
  get(account: string, calendarId: string): CalendarSummary | null;
  // Records the User's switch. Returns false for a calendar the Account doesn't list.
  setOn(account: string, calendarId: string, on: boolean): boolean;
  // The Account was removed.
  remove(account: string): void;
};

const DEFAULT_LIMIT = 2000;

function toSummary(row: typeof schema.calendars.$inferSelect): CalendarSummary {
  const source = row.source === 'outlook-calendar' ? 'outlook-calendar' : 'google-calendar';
  const known = { primary: row.primary, accessRole: row.accessRole };
  return {
    account: row.account,
    source,
    id: row.calendarId,
    name: row.name,
    colour: row.colour,
    primary: row.primary,
    accessRole: row.accessRole,
    on: row.on ?? calendarOnByDefault(known),
  };
}

export function calendarsIn(db: BetterSQLite3Database<typeof schema>): CalendarStore {
  const { calendars } = schema;
  const read = (account?: string) =>
    db
      .select()
      .from(calendars)
      .where(account ? eq(calendars.account, account) : undefined)
      .orderBy(asc(calendars.account), asc(calendars.position))
      .all()
      .map(toSummary);

  return {
    listed(account, source, listed) {
      listed.forEach((calendar, position) => {
        const values = {
          source,
          name: calendar.name,
          colour: calendar.colour,
          primary: calendar.primary,
          accessRole: calendar.accessRole,
          position,
        };
        db.insert(calendars)
          .values({ account, calendarId: calendar.id, ...values })
          .onConflictDoUpdate({ target: [calendars.account, calendars.calendarId], set: values })
          .run();
      });
      const ids = listed.map((calendar) => calendar.id);
      db.delete(calendars)
        .where(
          and(eq(calendars.account, account), ids.length ? notInArray(calendars.calendarId, ids) : undefined),
        )
        .run();
      return new Set(
        read(account)
          .filter((calendar) => calendar.on)
          .map((calendar) => calendar.id),
      );
    },

    list: (account) => read(account),

    get(account, calendarId) {
      const row = db
        .select()
        .from(calendars)
        .where(and(eq(calendars.account, account), eq(calendars.calendarId, calendarId)))
        .get();
      return row ? toSummary(row) : null;
    },

    setOn(account, calendarId, on) {
      const changed = db
        .update(calendars)
        .set({ on })
        .where(and(eq(calendars.account, account), eq(calendars.calendarId, calendarId)))
        .run();
      return changed.changes > 0;
    },

    remove(account) {
      db.delete(calendars).where(eq(calendars.account, account)).run();
    },
  };
}

// An all-day event's days, anywhere on Earth: from UTC-12 to UTC+14.
const EARLIEST_ZONE_MS = 14 * 60 * 60_000;
const LATEST_ZONE_MS = 12 * 60 * 60_000;

/** The time range an event's detail row keeps, widened for all-day events. */
export function eventRange(detail: { start: { at: number }; end: { at: number }; allDay: boolean }): {
  startAt: number;
  endAt: number;
} {
  if (!detail.allDay) return { startAt: detail.start.at, endAt: detail.end.at };
  return {
    startAt: Math.max(0, detail.start.at - EARLIEST_ZONE_MS),
    endAt: detail.end.at + LATEST_ZONE_MS,
  };
}

/** The rows of the live events overlapping a range, earliest first. */
export function eventRows(db: BetterSQLite3Database<typeof schema>, input: EventQuery): ItemRow[] {
  const query = eventQuery.parse(input);
  const { items, eventDetails } = schema;
  return db
    .select({ item: items })
    .from(eventDetails)
    .innerJoin(items, eq(items.id, eventDetails.itemId))
    .where(
      and(
        isNull(items.deletedAt),
        lt(eventDetails.startAt, query.to),
        // An event that takes no time still counts at its start.
        or(gt(eventDetails.endAt, query.from), gte(eventDetails.startAt, query.from)),
        query.accounts ? inArray(items.account, query.accounts) : undefined,
      ),
    )
    .orderBy(asc(eventDetails.startAt), asc(eventDetails.endAt), asc(items.title))
    .limit(query.limit ?? DEFAULT_LIMIT)
    .all()
    .map((row) => row.item);
}

/** The rows of an Account's live events on one calendar. */
export function calendarEventRows(
  db: BetterSQLite3Database<typeof schema>,
  { source, account, calendarId }: { source: Source; account: string; calendarId: string },
): ItemRow[] {
  const { items, eventDetails } = schema;
  return db
    .select({ item: items })
    .from(eventDetails)
    .innerJoin(items, eq(items.id, eventDetails.itemId))
    .where(
      and(
        eq(items.source, source),
        eq(items.account, account),
        eq(eventDetails.calendarId, calendarId),
        isNull(items.deletedAt),
      ),
    )
    .all()
    .map((row) => row.item);
}
