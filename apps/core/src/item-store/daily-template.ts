// Settings → Notes → Daily template, kept in the Item store's database so the Item store stays its
// only writer. A setting, not Items: saving it is not an Item change, so it is not in the activity log.
import {
  type DailyTemplate,
  dailyTemplate,
  defaultDailyTemplate,
  type TemplateBlock,
} from '@commander/domain';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type DailyTemplateStore = {
  // The template, or the default one until the User has saved one.
  read(): DailyTemplate;
  // Validates, saves and returns the template. Throws on one outside the contract.
  save(template: DailyTemplate): DailyTemplate;
};

export function dailyTemplateIn(
  db: BetterSQLite3Database<typeof schema>,
  now: () => number,
): DailyTemplateStore {
  const table = schema.dailyTemplate;
  return {
    read() {
      const row = db.select().from(table).where(eq(table.id, 1)).get();
      // Anything unreadable (e.g. from an older shape) falls back to the default.
      const parsed = dailyTemplate.safeParse(row?.template);
      return parsed.success ? parsed.data : structuredClone(defaultDailyTemplate);
    },

    save(input) {
      const template = dailyTemplate.parse(input);
      const updatedAt = now();
      db.insert(table)
        .values({ id: 1, template, updatedAt })
        .onConflictDoUpdate({ target: table.id, set: { template, updatedAt } })
        .run();
      return template;
    },
  };
}

/**
 * The template's Blocks parents first, so each can be made under one made before it. A Block whose
 * parent is not in the template goes to the top (as the outliner shows it), and one caught in a loop
 * of parents, which no outline can show, is left out.
 */
export function inCopyOrder(blocks: readonly TemplateBlock[]): TemplateBlock[] {
  const ids = new Set(blocks.map((block) => block.id));
  const parentOf = (block: TemplateBlock) =>
    block.parentId !== null && ids.has(block.parentId) ? block.parentId : null;
  const ordered: TemplateBlock[] = [];
  const walk = (parentId: string | null) => {
    for (const block of blocks.filter((b) => parentOf(b) === parentId)) {
      ordered.push({ ...block, parentId });
      walk(block.id);
    }
  };
  walk(null);
  return ordered;
}
