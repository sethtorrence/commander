// Settings → Calendar's scheduling (#132): the Account and calendar new events go in, and the User's
// Google booking link. Kept in the Item store's database so the Item store stays its only writer. A
// setting, not an Item: changing it is not in the activity log.
import {
  defaultSchedulingSettings,
  type SchedulingSettings,
  type SchedulingSettingsInput,
  schedulingSettings,
} from '@commander/domain';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type SchedulingSettingsStore = {
  // The settings, or the defaults (nothing chosen, no booking link) until the User changes them.
  read(): SchedulingSettings;
  // Validates, saves and returns them.
  save(settings: SchedulingSettingsInput): SchedulingSettings;
};

export function schedulingSettingsIn(
  db: BetterSQLite3Database<typeof schema>,
  now: () => number,
): SchedulingSettingsStore {
  const table = schema.schedulingSettings;
  return {
    read() {
      const row = db.select().from(table).where(eq(table.id, 1)).get();
      const parsed = schedulingSettings.safeParse(row?.settings ?? {});
      return parsed.success ? parsed.data : defaultSchedulingSettings();
    },

    save(input) {
      const settings = schedulingSettings.parse(input);
      const updatedAt = now();
      db.insert(table)
        .values({ id: 1, settings, updatedAt })
        .onConflictDoUpdate({ target: table.id, set: { settings, updatedAt } })
        .run();
      return settings;
    },
  };
}
