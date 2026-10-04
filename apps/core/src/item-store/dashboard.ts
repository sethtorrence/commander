// The Dashboard's side of the Item store (#72): Ares's latest ranking (written by his "Rank the
// Dashboard" job, ../agent/rank-dashboard.ts), the rows the User cleared, and what the window reads:
// Ares's ranking, or why the rules rank the Dashboard instead. It shares the Item store's database,
// so the Item store stays its only writer. Neither changes any Item: the ranked list is a view.
import {
  type AresRankingEntry,
  type DashboardBand,
  type DashboardClears,
  type DashboardRanking,
  type DashboardState,
  decide,
  type Item,
  RANK_DASHBOARD,
  rankingFingerprint,
} from '@commander/domain';
import { asc } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { AgentStore } from './agent-jobs';
import type { AutonomyStore } from './autonomy';
import * as schema from './schema';

export type StoredClear = { itemId: string; band: DashboardBand; at: number; fingerprint: string | null };

export type DashboardStore = {
  // Ares's latest ranking: when he made it (null before his first) and each entry.
  aresRanking(): { at: number | null; entries: AresRankingEntry[] };
  // Replaces his ranking with a new one, made at `at`.
  saveAresRanking(at: number, entries: AresRankingEntry[]): void;
  // What the window reads: the ranking (his, or the rules' with why) and the cleared rows.
  state(): DashboardState;
  // The cleared rows, each with a fingerprint of its Item when it was cleared (null for a suggestion).
  clears(): StoredClear[];
  // Replaces the cleared rows. A row cleared before keeps its fingerprint; a new one takes its Item's
  // as it is now.
  saveClears(clears: DashboardClears): DashboardClears;
};

const FAILED: Record<string, (problem: string | null) => string> = {
  failed: (problem) => `Ares couldn’t rank it: ${problem ?? 'his model didn’t answer'}`,
  'over-cap': () => 'Ares couldn’t rank it: this month’s cap is reached',
  'invalid-reply': () => 'Ares couldn’t rank it: his reply didn’t make sense',
};

export function openDashboardStore(
  db: BetterSQLite3Database<typeof schema>,
  deps: { agent: AgentStore; autonomy: Pick<AutonomyStore, 'settings'>; readItem(id: string): Item | null },
): DashboardStore {
  const { dashboardRankings, dashboardRanked, dashboardClears } = schema;

  function aresRanking() {
    const at = db.select().from(dashboardRanked).get()?.at ?? null;
    const entries = db.select().from(dashboardRankings).orderBy(asc(dashboardRankings.rank)).all();
    return { at, entries };
  }

  function clears(): StoredClear[] {
    return db.select().from(dashboardClears).orderBy(asc(dashboardClears.at)).all();
  }

  // Why the rules rank the Dashboard rather than Ares, or null when his ranking stands.
  function whyRules(at: number | null): string | null {
    const job = deps.agent.job(RANK_DASHBOARD);
    if (!job.enabled) return 'Rank the Dashboard is switched off in Settings → Ares';
    const level = decide(
      { action: RANK_DASHBOARD, actionKind: 'organise', section: null, confidence: 1, chained: false },
      deps.autonomy.settings(),
    );
    if (level === 'off') return 'Ares is Off for ranking the Dashboard';
    const failed = job.lastOutcome ? FAILED[job.lastOutcome] : undefined;
    if (failed) return failed(job.lastProblem);
    if (at === null) return 'Ares hasn’t ranked it yet';
    return null;
  }

  return {
    aresRanking,

    saveAresRanking(at, entries) {
      db.transaction((tx) => {
        tx.delete(dashboardRankings).run();
        if (entries.length) tx.insert(dashboardRankings).values(entries).run();
        tx.insert(dashboardRanked)
          .values({ id: 1, at })
          .onConflictDoUpdate({ target: dashboardRanked.id, set: { at } })
          .run();
      });
    },

    state() {
      const ranked = aresRanking();
      const why = whyRules(ranked.at);
      const ranking: DashboardRanking = why
        ? { by: 'rules', at: null, why, entries: [] }
        : { by: 'ares', at: ranked.at, why: null, entries: ranked.entries };
      const cleared = Object.fromEntries(clears().map(({ itemId, band, at }) => [itemId, { band, at }]));
      return { ranking, clears: cleared };
    },

    clears,

    saveClears(next) {
      const before = new Map(clears().map((clear) => [clear.itemId, clear]));
      db.transaction((tx) => {
        tx.delete(dashboardClears).run();
        for (const [itemId, { band, at }] of Object.entries(next)) {
          // The same clear as before (a new one has its own time) keeps its fingerprint.
          const was = before.get(itemId);
          const kept = was && was.band === band && was.at === at ? was : undefined;
          const item = kept ? null : deps.readItem(itemId);
          const fingerprint = kept ? kept.fingerprint : item ? rankingFingerprint(item) : null;
          tx.insert(dashboardClears).values({ itemId, band, at, fingerprint }).run();
        }
      });
      return Object.fromEntries(clears().map(({ itemId, band, at }) => [itemId, { band, at }]));
    },
  };
}
