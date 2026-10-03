// The sync side of the Item store: where each Account's sync stands (cursor, last sync, back-off,
// cadence) and a short history of sync runs with what each cost the Source. It shares the Item
// store's database, so the Item store stays its only writer. Tokens never come here.
import type { Source, SyncOutcomeKind, SyncProblem, SyncTrigger } from '@commander/domain';
import { and, count, desc, eq, isNull, lt } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type SyncState = {
  account: string;
  source: Source;
  // null: the Source's default.
  cadenceMinutes: number | null;
  // The Source adapter's own cursor, as it returned it.
  cursor: unknown;
  lastSyncedAt: number | null;
  failures: number;
  retryAt: number | null;
  problem: SyncProblem | null;
};

export type SyncRun = {
  id: number;
  account: string;
  source: Source;
  trigger: SyncTrigger;
  startedAt: number;
  finishedAt: number;
  outcome: SyncOutcomeKind;
  created: number;
  updated: number;
  tombstoned: number;
  unchanged: number;
  requests: number;
  complexity: number | null;
  error: string | null;
};

export type SyncStateStore = {
  get(account: string): SyncState | null;
  save(state: SyncState): void;
  // When the Account is removed.
  remove(account: string): void;
  recordRun(run: Omit<SyncRun, 'id'>): void;
  // Newest first.
  runs(account: string, limit?: number): SyncRun[];
  // How many of the Account's Items Commander holds, tombstones aside.
  countItems(source: Source, account: string): number;
};

// Runs kept per Account: about two days at the default cadence.
const RUNS_KEPT = 200;

export function openSyncStateStore(db: BetterSQLite3Database<typeof schema>): SyncStateStore {
  const { syncState, syncRuns, items } = schema;
  return {
    get(account) {
      const row = db.select().from(syncState).where(eq(syncState.account, account)).get();
      return row ? { ...row, cursor: row.cursor ?? null, problem: row.problem ?? null } : null;
    },

    save(state) {
      const { account, ...values } = state;
      db.insert(syncState)
        .values({ account, ...values })
        .onConflictDoUpdate({ target: syncState.account, set: values })
        .run();
    },

    remove(account) {
      db.delete(syncState).where(eq(syncState.account, account)).run();
      db.delete(syncRuns).where(eq(syncRuns.account, account)).run();
    },

    recordRun(run) {
      db.insert(syncRuns).values(run).run();
      const oldestKept = db
        .select({ id: syncRuns.id })
        .from(syncRuns)
        .where(eq(syncRuns.account, run.account))
        .orderBy(desc(syncRuns.id))
        .limit(1)
        .offset(RUNS_KEPT - 1)
        .get();
      if (oldestKept) {
        db.delete(syncRuns)
          .where(and(eq(syncRuns.account, run.account), lt(syncRuns.id, oldestKept.id)))
          .run();
      }
    },

    runs(account, limit = 50) {
      return db
        .select()
        .from(syncRuns)
        .where(eq(syncRuns.account, account))
        .orderBy(desc(syncRuns.id))
        .limit(limit)
        .all();
    },

    countItems(source, account) {
      const row = db
        .select({ n: count() })
        .from(items)
        .where(and(eq(items.source, source), eq(items.account, account), isNull(items.deletedAt)))
        .get();
      return row?.n ?? 0;
    },
  };
}
