// Settings → Data → Markdown copy folder (#53), kept in the Item store's database so the Item store
// stays its only writer. A setting, not an Item: changing it is not in the activity log.
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type MarkdownCopyFolderStore = {
  // The folder the copy is written to, or null while the copy is off.
  read(): string | null;
  // Saves the folder (null turns the copy off).
  save(folder: string | null): void;
};

export function markdownCopyFolderIn(
  db: BetterSQLite3Database<typeof schema>,
  now: () => number,
): MarkdownCopyFolderStore {
  const table = schema.markdownCopy;
  return {
    read() {
      return db.select().from(table).where(eq(table.id, 1)).get()?.folder ?? null;
    },

    save(folder) {
      const updatedAt = now();
      db.insert(table)
        .values({ id: 1, folder, updatedAt })
        .onConflictDoUpdate({ target: table.id, set: { folder, updatedAt } })
        .run();
    },
  };
}
