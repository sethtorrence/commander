// The model side of the Item store: the usage ledger behind the model client, the monthly cap
// warning and Settings → Ares. It shares the Item store's database, so the Item store stays its
// only writer.
import {
  type CapWarning,
  capWarning,
  defaultModelSettings,
  type ModelCall,
  type ModelSettings,
  modelCall,
  modelSettings,
  type UsageSummary,
  type UsageTotals,
} from '@commander/domain';
import { eq, gte, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type ModelStore = {
  // The usage ledger (the model client's UsageLedger).
  record(call: ModelCall): void;
  spentSince(at: number): number;
  recordCapWarning(warning: CapWarning): boolean;
  // This month's usage, in the User's local time, for the Usage page.
  usageSummary(): UsageSummary;
  settings(): ModelSettings;
  // Validates, saves and returns the settings. Throws on settings outside the contract.
  saveSettings(settings: ModelSettings): ModelSettings;
};

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (at: number) => {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const localMonth = (at: number) => localDay(at).slice(0, 7);

const emptyTotals = (): UsageTotals => ({
  calls: 0,
  errors: 0,
  inputTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  unpricedCalls: 0,
});

function add(totals: UsageTotals, call: ModelCall) {
  totals.calls += 1;
  if (call.outcome !== 'ok') totals.errors += 1;
  totals.inputTokens += call.inputTokens;
  totals.cachedTokens += call.cachedTokens;
  totals.outputTokens += call.outputTokens;
  if (call.costUsd === null) totals.unpricedCalls += 1;
  else totals.costUsd += call.costUsd;
}

// Groups calls by a key, most expensive first (then most calls).
function breakdown<K extends string>(calls: ModelCall[], name: K, keyOf: (call: ModelCall) => string) {
  const groups = new Map<string, UsageTotals>();
  for (const call of calls) {
    const key = keyOf(call);
    const totals = groups.get(key) ?? emptyTotals();
    add(totals, call);
    groups.set(key, totals);
  }
  return [...groups]
    .map(([key, totals]) => ({ ...totals, [name]: key }) as UsageTotals & Record<K, string>)
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
}

export function openModelStore(db: BetterSQLite3Database<typeof schema>, now: () => number): ModelStore {
  const { modelCalls, modelCapWarnings } = schema;

  function capWarningFor(month: string): CapWarning | null {
    const row = db.select().from(modelCapWarnings).where(eq(modelCapWarnings.month, month)).get();
    return row ? capWarning.parse(row) : null;
  }

  // Anything unreadable (e.g. from an older shape) falls back to the defaults.
  function readSettings(): ModelSettings {
    const row = db.select().from(schema.modelSettings).where(eq(schema.modelSettings.id, 1)).get();
    const parsed = modelSettings.safeParse(row?.settings);
    return parsed.success ? parsed.data : structuredClone(defaultModelSettings);
  }

  return {
    record(call) {
      db.insert(modelCalls).values(modelCall.parse(call)).run();
    },

    spentSince(at) {
      const row = db
        .select({ spent: sql<number | null>`sum(${modelCalls.costUsd})` })
        .from(modelCalls)
        .where(gte(modelCalls.at, at))
        .get();
      return row?.spent ?? 0;
    },

    recordCapWarning(warning) {
      const inserted = db
        .insert(modelCapWarnings)
        .values(capWarning.parse(warning))
        .onConflictDoNothing()
        .returning()
        .all();
      return inserted.length > 0;
    },

    usageSummary() {
      const at = now();
      const today = new Date(at);
      const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
      const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      const calls: ModelCall[] = db.select().from(modelCalls).where(gte(modelCalls.at, monthStart)).all();

      const todayTotals = emptyTotals();
      const monthTotals = emptyTotals();
      for (const call of calls) {
        add(monthTotals, call);
        if (call.at >= dayStart) add(todayTotals, call);
      }
      const month = localMonth(at);
      return {
        month,
        today: todayTotals,
        thisMonth: monthTotals,
        byDay: breakdown(calls, 'day', (call) => localDay(call.at)).sort((a, b) =>
          b.day.localeCompare(a.day),
        ),
        byJob: breakdown(calls, 'job', (call) => call.job),
        byProvider: breakdown(calls, 'provider', (call) => call.provider),
        monthlyCapUsd: readSettings().monthlyCapUsd,
        capWarning: capWarningFor(month),
      };
    },

    settings: readSettings,

    saveSettings(input) {
      const settings = modelSettings.parse(input);
      db.insert(schema.modelSettings)
        .values({ id: 1, settings, updatedAt: now() })
        .onConflictDoUpdate({ target: schema.modelSettings.id, set: { settings, updatedAt: now() } })
        .run();
      return settings;
    },
  };
}
