// Ares's filing in the Item store (#71): his suggestions waiting on Items (the dashed Badge), the
// User's answers to his filing, and his filing record.
//
// - A pending "File into Projects" suggestion decorates its Item (and a Todo backed by it) as it is
//   read, like the warning mark: `filingSuggestion`.
// - Whenever the User files an Item that Ares filed, or that has his suggestion waiting, the answer
//   is recorded beside the filing: a `confirmation` when they kept his Project, a `correction`
//   otherwise (another Project, or Unfiled). Before is his suggestion and after the User's choice, as
//   `{ filing }`. They are never undone: they are what he learns from (the Memory ticket turns them
//   into examples, and enough of one kind suggest a Rule).
import {
  type ActivityEntry,
  type Actor,
  type CausedBy,
  FILE_INTO_PROJECTS,
  type Filing,
  type FilingFeedback,
  type FilingRecord,
  type FilingSuggestion,
  type Item,
  type ItemState,
} from '@commander/domain';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

type NewFeedback = {
  by: Actor;
  action: 'correction' | 'confirmation';
  itemId: string;
  causedBy: CausedBy | null;
  before: { filing: Filing };
  after: { filing: Filing };
};

export type FilingFeedbackStore = {
  // Ares's filing record: Items he filed on his own, suggestions he left, and the User's answers.
  record(): FilingRecord;
  // Every correction and confirmation, newest first.
  feedback(): FilingFeedback[];
};

export function filingFeedbackIn(
  db: BetterSQLite3Database<typeof schema>,
  log: (entry: NewFeedback, at: number) => ActivityEntry,
) {
  const { proposals, activity } = schema;

  const projectOf = (steps: unknown): string | null => {
    const step = (steps as { type: string; changes?: { filing?: Filing } }[])[0];
    return step?.type === 'update' ? (step.changes?.filing?.projectId ?? null) : null;
  };

  // The pending filing suggestions on these Items, by Item.
  function suggestions(itemIds: readonly string[]): Map<string, FilingSuggestion> {
    const found = new Map<string, FilingSuggestion>();
    for (let i = 0; i < itemIds.length; i += 500) {
      const rows = db
        .select({ id: proposals.id, itemId: proposals.itemId, steps: proposals.itemActions })
        .from(proposals)
        .where(
          and(
            eq(proposals.action, FILE_INTO_PROJECTS),
            eq(proposals.status, 'pending'),
            inArray(proposals.itemId, itemIds.slice(i, i + 500)),
          ),
        )
        .orderBy(desc(proposals.id))
        .all();
      for (const row of rows) {
        const projectId = projectOf(row.steps);
        if (projectId && !found.has(row.itemId)) found.set(row.itemId, { proposalId: row.id, projectId });
      }
    }
    return found;
  }

  // What Ares said about an Item the User is filing now: his waiting suggestion, else his own filing.
  function aresSaid(item: Item, before: ItemState): string | null {
    const waiting = suggestions([item.id]).get(item.id);
    if (waiting) return waiting.projectId;
    return before.filing?.filedBy === 'ares' ? before.filing.projectId : null;
  }

  // Records the User's answer to Ares's filing, if this change is one.
  function answer(item: Item, before: ItemState, after: ItemState, entry: ActivityEntry, at: number) {
    if (entry.by.kind !== 'user' || before.filing?.filedBy === 'user') return;
    const same =
      before.filing?.projectId === after.filing?.projectId &&
      before.filing?.filedBy === after.filing?.filedBy;
    if (same) return;
    const suggested = aresSaid(item, before);
    if (!suggested) return;
    const chosen = after.filing?.projectId ?? null;
    log(
      {
        by: entry.by,
        action: chosen === suggested ? 'confirmation' : 'correction',
        itemId: item.id,
        causedBy: { entryId: entry.id },
        before: { filing: { projectId: suggested, filedBy: 'ares' } },
        after: { filing: after.filing },
      },
      at,
    );
  }

  // The User turned down a filing suggestion without filing the Item (Unfiled): a correction.
  function decline(itemId: string, suggested: string, by: Actor, at: number): ActivityEntry {
    return log(
      {
        by,
        action: 'correction',
        itemId,
        causedBy: null,
        before: { filing: { projectId: suggested, filedBy: 'ares' } },
        after: { filing: null },
      },
      at,
    );
  }

  const count = (rows: { n: number } | undefined) => Number(rows?.n ?? 0);

  const store: FilingFeedbackStore = {
    record() {
      const proposalsWhere = (where: ReturnType<typeof sql>) =>
        count(
          db
            .select({ n: sql<number>`count(*)` })
            .from(proposals)
            .where(and(eq(proposals.action, FILE_INTO_PROJECTS), where))
            .get(),
        );
      const answers = (action: 'correction' | 'confirmation') =>
        count(
          db.select({ n: sql<number>`count(*)` }).from(activity).where(eq(activity.action, action)).get(),
        );
      return {
        filed: proposalsWhere(sql`${proposals.status} = 'done'`),
        suggested: proposalsWhere(sql`${proposals.decision} = 'ask'`),
        confirmed: answers('confirmation'),
        corrected: answers('correction'),
      };
    },

    feedback() {
      return db
        .select()
        .from(activity)
        .where(inArray(activity.action, ['correction', 'confirmation']))
        .orderBy(desc(activity.id))
        .all()
        .flatMap((row): FilingFeedback[] => {
          const suggested = (row.before as { filing?: Filing } | null)?.filing?.projectId;
          if (!suggested) return [];
          return [
            {
              entryId: row.id,
              at: row.at,
              kind: row.action === 'confirmation' ? 'confirmation' : 'correction',
              itemId: row.itemId,
              suggested,
              chosen: (row.after as { filing?: Filing } | null)?.filing?.projectId ?? null,
            },
          ];
        });
    },
  };

  return { suggestions, answer, decline, store };
}
