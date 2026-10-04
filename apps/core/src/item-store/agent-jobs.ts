// The job runner's side of the Item store (../agent): where each of Ares's jobs stands, and what each
// has already looked at. It shares the Item store's database, so the Item store stays its only
// writer. Ares's own changes never come this way: his jobs only propose, through the gate.
import type { ItemKind, JobOutcome } from '@commander/domain';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type JobState = {
  job: string;
  enabled: boolean;
  // The last activity entry the job has looked at, or null before its first run.
  cursor: number | null;
  lastRunAt: number | null;
  lastOutcome: JobOutcome | null;
  lastProblem: string | null;
  // Failed runs in a row, and when automatic triggers may run it again.
  failures: number;
  retryAt: number | null;
};

export type SeenItem = { itemId: string; fingerprint: string; proposalId: number | null };

export type AgentStore = {
  // A job's state, with the defaults for one that has never run.
  job(job: string): JobState;
  saveJob(job: string, changes: Partial<Omit<JobState, 'job'>>): JobState;
  // Whether the job has looked at this Item as it is now (its fingerprint).
  seen(job: string, itemId: string, fingerprint: string): boolean;
  remember(job: string, items: SeenItem[]): void;
  // The live Items of these kinds the User changed after an activity entry (every one, from null),
  // and the latest entry in the log, which the job's cursor moves to.
  userChangesSince(
    after: number | null,
    kinds: readonly ItemKind[],
  ): { itemIds: string[]; lastEntryId: number };
  // The latest entry in the activity log (0 when it is empty).
  lastEntryId(): number;
};

export function openAgentStore(db: BetterSQLite3Database<typeof schema>, now: () => number): AgentStore {
  const { agentJobs, agentSeen, activity, items } = schema;

  const defaults = (job: string): JobState => ({
    job,
    enabled: true,
    cursor: null,
    lastRunAt: null,
    lastOutcome: null,
    lastProblem: null,
    failures: 0,
    retryAt: null,
  });

  function job(name: string): JobState {
    return db.select().from(agentJobs).where(eq(agentJobs.job, name)).get() ?? defaults(name);
  }

  function lastEntryId(): number {
    return db.select({ id: activity.id }).from(activity).orderBy(desc(activity.id)).limit(1).get()?.id ?? 0;
  }

  return {
    job,

    saveJob(name, changes) {
      const next = { ...job(name), ...changes, job: name };
      db.insert(agentJobs)
        .values(next)
        .onConflictDoUpdate({ target: agentJobs.job, set: { ...next } })
        .run();
      return next;
    },

    seen(name, itemId, fingerprint) {
      return !!db
        .select({ at: agentSeen.at })
        .from(agentSeen)
        .where(
          and(eq(agentSeen.job, name), eq(agentSeen.itemId, itemId), eq(agentSeen.fingerprint, fingerprint)),
        )
        .get();
    },

    remember(name, seen) {
      const at = now();
      for (const { itemId, fingerprint, proposalId } of seen) {
        db.insert(agentSeen)
          .values({ job: name, itemId, fingerprint, proposalId, at })
          .onConflictDoUpdate({
            target: [agentSeen.job, agentSeen.itemId, agentSeen.fingerprint],
            set: { proposalId: sql`coalesce(${proposalId}, ${agentSeen.proposalId})`, at },
          })
          .run();
      }
    },

    userChangesSince(after, kinds) {
      const latest = lastEntryId();
      if (!kinds.length) return { itemIds: [], lastEntryId: latest };
      const rows = db
        .selectDistinct({ itemId: activity.itemId })
        .from(activity)
        .innerJoin(items, eq(items.id, activity.itemId))
        .where(
          and(
            eq(activity.actor, 'user'),
            after === null ? undefined : gt(activity.id, after),
            sql`${activity.id} <= ${latest}`,
            inArray(items.kind, [...kinds]),
            sql`${items.deletedAt} IS NULL`,
          ),
        )
        .all();
      return { itemIds: rows.map((row) => row.itemId), lastEntryId: latest };
    },

    lastEntryId,
  };
}
