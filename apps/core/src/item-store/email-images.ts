// The email reader's image rules (#134), kept in the Item store's database so the Item store stays
// its only writer: each Account's Ask before showing images (Gmail Accounts), the senders whose
// images always show (Always show from this sender), and the messages whose images the User chose to
// show. Settings, not Item changes, so never in the activity log. Removing the Account removes them.
import { and, asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type EmailImagesStore = {
  askFirst(account: string): boolean;
  setAskFirst(account: string, on: boolean): void;
  senderTrusted(account: string, address: string): boolean;
  trustSender(account: string, address: string): void;
  untrustSender(account: string, address: string): void;
  // The Account's trusted senders, lower-case, in address order.
  trustedSenders(account: string): string[];
  messageShown(account: string, itemId: string): boolean;
  showMessage(account: string, itemId: string): void;
  removeAccount(account: string): void;
};

const normal = (address: string) => address.trim().toLowerCase();

export function emailImagesIn(db: BetterSQLite3Database<typeof schema>, now: () => number): EmailImagesStore {
  const { emailImageSettings: settings, emailImageTrust: trust } = schema;
  const has = (account: string, kind: 'sender' | 'message', value: string) =>
    !!db
      .select({ value: trust.value })
      .from(trust)
      .where(and(eq(trust.account, account), eq(trust.kind, kind), eq(trust.value, value)))
      .get();
  const add = (account: string, kind: 'sender' | 'message', value: string) =>
    db.insert(trust).values({ account, kind, value, createdAt: now() }).onConflictDoNothing().run();

  return {
    askFirst(account) {
      return (
        db.select({ askFirst: settings.askFirst }).from(settings).where(eq(settings.account, account)).get()
          ?.askFirst ?? false
      );
    },
    setAskFirst(account, on) {
      db.insert(settings)
        .values({ account, askFirst: on, updatedAt: now() })
        .onConflictDoUpdate({ target: settings.account, set: { askFirst: on, updatedAt: now() } })
        .run();
    },
    senderTrusted: (account, address) => has(account, 'sender', normal(address)),
    trustSender: (account, address) => add(account, 'sender', normal(address)),
    untrustSender(account, address) {
      db.delete(trust)
        .where(and(eq(trust.account, account), eq(trust.kind, 'sender'), eq(trust.value, normal(address))))
        .run();
    },
    trustedSenders(account) {
      return db
        .select({ value: trust.value })
        .from(trust)
        .where(and(eq(trust.account, account), eq(trust.kind, 'sender')))
        .orderBy(asc(trust.value))
        .all()
        .map((row) => row.value);
    },
    messageShown: (account, itemId) => has(account, 'message', itemId),
    showMessage: (account, itemId) => add(account, 'message', itemId),
    removeAccount(account) {
      db.delete(trust).where(eq(trust.account, account)).run();
      db.delete(settings).where(eq(settings.account, account)).run();
    },
  };
}
