// Settings → Calendar (#128), kept in the Item store's database so the Item store stays its only
// writer. A setting, not an Item: changing it is not in the activity log.
import {
  type CalendarSettings,
  calendarSettings as calendarSettingsSchema,
  defaultCalendarSettings,
} from '@commander/domain';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type CalendarSettingsStore = {
  // The settings, or the defaults (the heads-up off, no second time zone) until the User changes them.
  read(): CalendarSettings;
  // Validates, saves and returns them.
  save(settings: CalendarSettings): CalendarSettings;
};

export function calendarSettingsIn(
  db: BetterSQLite3Database<typeof schema>,
  now: () => number,
): CalendarSettingsStore {
  const table = schema.calendarSettings;
  const read = (): CalendarSettings => {
    const row = db.select().from(table).where(eq(table.id, 1)).get();
    if (!row) return { ...defaultCalendarSettings };
    return { headsUp: row.headsUp, ...(row.secondTimeZone && { secondTimeZone: row.secondTimeZone }) };
  };
  return {
    read,

    save(input) {
      const parsed = calendarSettingsSchema.parse(input);
      const updatedAt = now();
      // The second time zone (#127): left out, it stays as saved; null clears it.
      const secondTimeZone =
        parsed.secondTimeZone === undefined ? (read().secondTimeZone ?? null) : parsed.secondTimeZone;
      db.insert(table)
        .values({ id: 1, headsUp: parsed.headsUp, secondTimeZone, updatedAt })
        .onConflictDoUpdate({ target: table.id, set: { headsUp: parsed.headsUp, secondTimeZone, updatedAt } })
        .run();
      return read();
    },
  };
}
