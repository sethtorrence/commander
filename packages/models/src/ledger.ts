import type { CapWarning, ModelCall } from '@commander/domain';

type MaybePromise<T> = T | Promise<T>;

// Where the model client writes down every call. In Commander it is the Item store's database;
// tests use the in-memory one below.
export type UsageLedger = {
  record(call: ModelCall): MaybePromise<void>;
  // Dollars spent on calls made at or after this time (epoch ms).
  spentSince(at: number): MaybePromise<number>;
  // Records the month's 80% warning. Returns false, recording nothing, if the month already has one.
  recordCapWarning(warning: CapWarning): MaybePromise<boolean>;
};

export type MemoryLedger = UsageLedger & { calls: ModelCall[]; capWarnings: CapWarning[] };

export function createMemoryLedger(): MemoryLedger {
  const calls: ModelCall[] = [];
  const capWarnings: CapWarning[] = [];
  return {
    calls,
    capWarnings,
    record: (call) => {
      calls.push(call);
    },
    spentSince: (at) =>
      calls.filter((call) => call.at >= at).reduce((sum, call) => sum + (call.costUsd ?? 0), 0),
    recordCapWarning: (warning) => {
      if (capWarnings.some((existing) => existing.month === warning.month)) return false;
      capWarnings.push(warning);
      return true;
    },
  };
}
