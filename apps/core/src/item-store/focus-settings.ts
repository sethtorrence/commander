// Settings → Calendar's focus time (#131): the working hours, the Account whose Commander calendar
// focus blocks go in, and the pairs of Block time across Accounts. Kept in the Item store's database
// so the Item store stays its only writer. A setting, not an Item: changing it is not in the activity log.
import {
  defaultFocusSettings,
  type FocusSettings,
  type FocusSettingsInput,
  focusSettings,
} from '@commander/domain';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type FocusSettingsStore = {
  // The settings, or the defaults until the User changes them.
  read(): FocusSettings;
  // Validates, saves and returns them.
  save(settings: FocusSettingsInput): FocusSettings;
};

export function focusSettingsIn(
  db: BetterSQLite3Database<typeof schema>,
  now: () => number,
): FocusSettingsStore {
  const table = schema.focusSettings;
  return {
    read() {
      const row = db.select().from(table).where(eq(table.id, 1)).get();
      // Settings saved by an older Commander take today's defaults for anything they lack.
      const parsed = focusSettings.safeParse(row?.settings ?? {});
      return parsed.success ? parsed.data : defaultFocusSettings();
    },

    save(input) {
      const settings = focusSettings.parse(input);
      const updatedAt = now();
      db.insert(table)
        .values({ id: 1, settings, updatedAt })
        .onConflictDoUpdate({ target: table.id, set: { settings, updatedAt } })
        .run();
      return settings;
    },
  };
}
