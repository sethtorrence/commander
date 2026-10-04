// Muting and excluding Teams Chats (#105), kept in the Item store's database so the Item store stays
// its only writer. Settings, not Item changes: muting is not in the activity log. Excluding a Chat
// also deletes its Item, as the User (as when an Account is removed: a tombstone, so notes and Todos
// keep their Links, shown as gone), and the sync engine tells the Teams adapter to skip it until it
// is included again, when the next sync brings its Item back.
import type { ActionContext, ActivityEntry, ChatSetting, ChatSettingAction, Item } from '@commander/domain';
import { chatSettingAction } from '@commander/domain';
import { and, asc, eq, isNotNull, or } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type ChatSettingsStore = {
  // The Chats muted or excluded, by Account then oldest change first; one Account's when given.
  list(account?: string): ChatSetting[];
  // Mutes, unmutes, excludes or includes a Chat. Returns the setting as it now stands, the Chat's
  // Item, and the entry deleting it when excluding did.
  change(
    action: ChatSettingAction,
    context: ActionContext,
  ): { setting: ChatSetting; itemId: string | null; entry: ActivityEntry | null };
  // The Teams ids of an Account's excluded Chats, for its sync to skip.
  excluded(account: string): string[];
  // When the Account is removed.
  removeAccount(account: string): void;
};

const WHY_EXCLUDED = 'Excluded the Chat from Commander';

export function chatSettingsIn(
  db: BetterSQLite3Database<typeof schema>,
  {
    now,
    findChat,
    deleteItem,
  }: {
    now: () => number;
    // The Chat's Item, tombstones included, or null.
    findChat: (account: string, chatId: string) => Item | null;
    // Deletes an Item, recording it with the context given.
    deleteItem: (itemId: string, context: ActionContext) => ActivityEntry;
  },
): ChatSettingsStore {
  const table = schema.chatSettings;
  const key = (account: string, chatId: string) => and(eq(table.account, account), eq(table.chatId, chatId));
  const read = (account: string, chatId: string): ChatSetting | null =>
    db.select().from(table).where(key(account, chatId)).get() ?? null;

  return {
    list(account) {
      return db
        .select()
        .from(table)
        .where(
          and(
            account ? eq(table.account, account) : undefined,
            or(eq(table.muted, true), isNotNull(table.excludedAt)),
          ),
        )
        .orderBy(asc(table.account), asc(table.updatedAt), asc(table.chatId))
        .all();
    },

    change(raw, context) {
      const { account, chatId, change } = chatSettingAction.parse(raw);
      const at = now();
      const item = findChat(account, chatId);
      const was = read(account, chatId);
      const name = (item?.title || was?.name) ?? 'Chat';
      const muted = change === 'mute' ? true : change === 'unmute' ? false : (was?.muted ?? false);
      const excludedAt =
        change === 'exclude'
          ? (was?.excludedAt ?? at)
          : change === 'include'
            ? null
            : (was?.excludedAt ?? null);
      const setting: ChatSetting = { account, chatId, name, muted, excludedAt, updatedAt: at };
      const { account: _account, chatId: _chatId, ...values } = setting;
      db.insert(table)
        .values(setting)
        .onConflictDoUpdate({ target: [table.account, table.chatId], set: values })
        .run();
      const entry =
        change === 'exclude' && item && item.deletedAt === null
          ? deleteItem(item.id, { ...context, why: context.why ?? WHY_EXCLUDED })
          : null;
      return { setting, itemId: item?.id ?? null, entry };
    },

    excluded(account) {
      return db
        .select({ chatId: table.chatId })
        .from(table)
        .where(and(eq(table.account, account), isNotNull(table.excludedAt)))
        .orderBy(asc(table.chatId))
        .all()
        .map((row) => row.chatId);
    },

    removeAccount(account) {
      db.delete(table).where(eq(table.account, account)).run();
    },
  };
}
