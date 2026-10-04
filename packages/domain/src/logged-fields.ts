import { z } from 'zod';
import type { ItemDetail, ItemKind } from './items';

// Detail fields too big to copy into the activity log every time a Source changes them (a Chat's
// messages: up to 200, before and after, several times a day). In the entries a Source's changes
// make, the log keeps such a field empty and records a summary instead: how many there are, how many
// were added, changed or removed, and the newest. Nothing reads those fields back from the log, and
// such an entry can't be undone (a message arriving in Teams isn't Commander's to take back).
// Changes made in Commander are always logged whole, so their undo works as before.
//
// Each field listed is an array of entries with an `id` (and a `createdAt`, for the newest). Other
// Sources with large detail (long Linear descriptions or comment threads, email bodies) can list
// theirs here once nothing they show from the log needs the full value.
const SUMMARISED: Partial<Record<ItemKind, readonly string[]>> = {
  chat: ['messages'],
};

/** The detail fields of this kind the log keeps only in summary. */
export function summarisedInLog(kind: ItemKind): readonly string[] {
  return SUMMARISED[kind] ?? [];
}

export const fieldSummary = z.object({
  field: z.string().min(1),
  // How many entries the field holds after the change.
  count: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  // The newest entry after the change, by `createdAt` (else the last), if any.
  latest: z.object({ id: z.string(), at: z.number().nullable() }).nullable(),
});
export type FieldSummary = z.infer<typeof fieldSummary>;

// Plain-data equality (the window loads this module too, so no node:util).
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

type Entry = { id: string; createdAt?: unknown };
const entriesOf = (value: unknown): Entry[] =>
  Array.isArray(value) ? value.filter((each): each is Entry => typeof each?.id === 'string') : [];

function summarise(field: string, before: unknown, after: unknown): FieldSummary {
  const was = new Map(entriesOf(before).map((entry) => [entry.id, entry]));
  const now = entriesOf(after);
  const ids = new Set(now.map((entry) => entry.id));
  let added = 0;
  let changed = 0;
  for (const entry of now) {
    const old = was.get(entry.id);
    if (!old) added += 1;
    else if (!same(old, entry)) changed += 1;
  }
  const removed = [...was.keys()].filter((id) => !ids.has(id)).length;
  const at = (entry: Entry) => (typeof entry.createdAt === 'number' ? entry.createdAt : null);
  const newest = now.reduce<Entry | null>(
    (best, entry) => (best === null || (at(entry) ?? 0) >= (at(best) ?? 0) ? entry : best),
    null,
  );
  return {
    field,
    count: now.length,
    added,
    changed,
    removed,
    latest: newest ? { id: newest.id, at: at(newest) } : null,
  };
}

/**
 * A Source's change to an Item's detail as the log keeps it: the fields summarised in the log
 * emptied in both states, and a summary of each. Details without such fields come back as they are.
 */
export function compactForLog<D extends ItemDetail | null>(
  before: D | null,
  after: D,
): { before: D | null; after: D; summaries: FieldSummary[] } {
  const fields = after ? summarisedInLog(after.kind) : [];
  if (!after || fields.length === 0) return { before, after, summaries: [] };
  const sameKind = before?.kind === after.kind ? before : null;
  const empty = (detail: D) =>
    ({ ...detail, ...Object.fromEntries(fields.map((field) => [field, []])) }) as D;
  const value = (detail: D | null, field: string) => (detail as Record<string, unknown> | null)?.[field];
  return {
    before: before && (sameKind ? empty(before) : before),
    after: empty(after),
    summaries: fields.map((field) => summarise(field, value(sameKind, field), value(after, field))),
  };
}
