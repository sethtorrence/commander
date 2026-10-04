// Ares's waiting flags on Teams Chats (#109), kept in the Item store's database so the Item store
// stays its only writer. "Spot what's waiting on you" (../agent/spot-waiting.ts) records how far it
// has read each Chat and flags the ones where someone is waiting on the User; a flag decorates its
// Chat's Item (`waiting`) wherever it is read, like the warning mark.
//
// - A flag is not a change to the Item: setting it, and its going when the User replies or Ares
//   judges the Chat no longer waiting, are not in the activity log.
// - The User clearing one by hand is: a `correction` by the User ("Not waiting on you"), kept as an
//   example for Memory, with the flag as `before` (and nothing `after`, so it lists no Item fields).
//   Undoing it brings the flag back (an undo entry with the flag `after`), and undoing that clears
//   it again. A message the User cleared is never flagged again.
import type { ActionContext, ActivityEntry, ChatWaiting } from '@commander/domain';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type FlaggedChat = { itemId: string } & ChatWaiting;

export type ChatWaitingStore = {
  // The newest message Ares judged in the Chat (its time), or null before he first looked.
  judgedThrough(itemId: string): number | null;
  judged(itemId: string, through: number): void;
  // The flags standing now.
  flagged(): FlaggedChat[];
  // Flags the Chat as waiting on the User. False (and nothing changes) when the User cleared that
  // message by hand.
  flag(itemId: string, flag: { messageId: string; reason: string }, at: number): boolean;
  // The flag goes: the User replied, or Ares judged it no longer waiting. False when none stood.
  clear(itemId: string, by: 'reply' | 'ares', at: number): boolean;
  // The User clears it by hand: returns the correction.
  clearByUser(itemId: string, context: ActionContext): ActivityEntry;
};

export type ChatWaitings = ChatWaitingStore & {
  // The standing flags on these Items, by Item, for decorating them as they are read.
  standing(itemIds: readonly string[]): Map<string, ChatWaiting>;
  // Whether an activity entry is a waiting correction (or an undo of one): undone here.
  isWaitingEntry(row: { before: unknown; after: unknown }): boolean;
  // Undoes such an entry: brings the flag back, or clears it again. Returns the undo entry.
  undo(
    target: { id: number; itemId: string; before: unknown; after: unknown },
    entry: Context,
    at: number,
  ): ActivityEntry;
};

type NewEntry = {
  by: ActivityEntry['by'];
  action: 'correction' | 'undo';
  itemId: string;
  why?: string | null;
  causedBy?: ActivityEntry['causedBy'];
  undoes?: number | null;
  before: unknown;
  after: unknown;
};

const WHY = 'Not waiting on you';

type Context = { by: ActivityEntry['by']; why?: string | null; causedBy?: ActivityEntry['causedBy'] };

const waitingIn = (state: unknown): ChatWaiting | null => {
  if (!state || typeof state !== 'object' || !('waiting' in state)) return null;
  const { waiting } = state as { waiting: ChatWaiting | null };
  return waiting && typeof waiting.messageId === 'string' ? waiting : null;
};

export class ChatWaitingError extends Error {
  override name = 'ChatWaitingError';
}

export function chatWaitingIn(
  db: BetterSQLite3Database<typeof schema>,
  { now, log }: { now: () => number; log: (entry: NewEntry, at: number) => ActivityEntry },
): ChatWaitings {
  const table = schema.chatWaiting;
  const row = (itemId: string) => db.select().from(table).where(eq(table.itemId, itemId)).get();
  const standingOf = (found: typeof table.$inferSelect | undefined): ChatWaiting | null =>
    found?.messageId && found.reason && found.flaggedAt !== null && found.clearedAt === null
      ? { messageId: found.messageId, reason: found.reason, at: found.flaggedAt }
      : null;

  function upsert(itemId: string, values: Partial<typeof table.$inferInsert>) {
    db.insert(table)
      .values({ itemId, ...values })
      .onConflictDoUpdate({ target: table.itemId, set: values })
      .run();
  }

  const put = (itemId: string, flag: ChatWaiting) =>
    upsert(itemId, {
      messageId: flag.messageId,
      reason: flag.reason,
      flaggedAt: flag.at,
      clearedAt: null,
      clearedBy: null,
      clearEntryId: null,
    });

  function clearByUser(itemId: string, context: Context, undoes?: number) {
    const flag = standingOf(row(itemId));
    if (!flag) throw new ChatWaitingError('That Chat isn’t marked as waiting on you');
    const at = now();
    const entry = log(
      {
        by: context.by,
        action: undoes ? 'undo' : 'correction',
        itemId,
        why: context.why ?? WHY,
        causedBy: context.causedBy ?? null,
        undoes: undoes ?? null,
        before: { waiting: flag },
        after: null,
      },
      at,
    );
    upsert(itemId, { clearedAt: at, clearedBy: 'user', clearEntryId: entry.id });
    return entry;
  }

  return {
    judgedThrough: (itemId) => row(itemId)?.judgedThrough ?? null,

    judged(itemId, through) {
      upsert(itemId, { judgedThrough: through });
    },

    flagged() {
      return db
        .select()
        .from(table)
        .where(and(isNotNull(table.flaggedAt), isNull(table.clearedAt)))
        .all()
        .flatMap((found) => {
          const flag = standingOf(found);
          return flag ? [{ itemId: found.itemId, ...flag }] : [];
        });
    },

    flag(itemId, { messageId, reason }, at) {
      const was = row(itemId);
      if (was?.clearedBy === 'user' && was.messageId === messageId) return false;
      put(itemId, { messageId, reason, at });
      return true;
    },

    clear(itemId, by, at) {
      if (!standingOf(row(itemId))) return false;
      upsert(itemId, { clearedAt: at, clearedBy: by, clearEntryId: null });
      return true;
    },

    clearByUser: (itemId, context) => clearByUser(itemId, context),

    standing(itemIds) {
      const found = new Map<string, ChatWaiting>();
      const ids = [...new Set(itemIds)];
      for (let start = 0; start < ids.length; start += 500) {
        const rows = db
          .select()
          .from(table)
          .where(and(inArray(table.itemId, ids.slice(start, start + 500)), isNull(table.clearedAt)))
          .all();
        for (const each of rows) {
          const flag = standingOf(each);
          if (flag) found.set(each.itemId, flag);
        }
      }
      return found;
    },

    isWaitingEntry: ({ before, after }) =>
      (waitingIn(before) !== null && after === null) || (before === null && waitingIn(after) !== null),

    undo(target, entry, at) {
      const cleared = waitingIn(target.before);
      // It cleared the flag: bring it back.
      if (cleared) {
        put(target.itemId, cleared);
        return log(
          {
            by: entry.by,
            action: 'undo',
            itemId: target.itemId,
            why: entry.why ?? null,
            causedBy: entry.causedBy ?? null,
            undoes: target.id,
            before: null,
            after: { waiting: cleared },
          },
          at,
        );
      }
      // It brought the flag back: clear it again.
      return clearByUser(target.itemId, entry, target.id);
    },
  };
}
