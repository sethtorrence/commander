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
  // The settings, or the defaults (the heads-up off) until the User changes them.
  read(): CalendarSettings;
  // Validates, saves and returns them.
  save(settings: CalendarSettings): CalendarSettings;
};

export function calendarSettingsIn(
  db: BetterSQLite3Database<typeof schema>,
  now: () => number,
): CalendarSettingsStore {
  const table = schema.calendarSettings;
  return {
    read() {
      const row = db.select().from(table).where(eq(table.id, 1)).get();
      return row ? { headsUp: row.headsUp } : { ...defaultCalendarSettings };
    },

    save(input) {
      const settings = calendarSettingsSchema.parse(input);
      const updatedAt = now();
      db.insert(table)
        .values({ id: 1, headsUp: settings.headsUp, updatedAt })
        .onConflictDoUpdate({ target: table.id, set: { headsUp: settings.headsUp, updatedAt } })
        .run();
      return settings;
    },
  };
}
