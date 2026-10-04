// A recurring series filed once (#127): each instance of a recurring event is its own Item, but they
// belong to one Project. "File into Projects" asks the model about one instance of a series; this
// files the series' other instances the way that one was filed, with no model call.
//
// - A series is settled when the instances the User or Ares filed all agree on one Project. Rules
//   are left out: a Rule matches every instance alike, and files them itself. A series filed two ways
//   is left alone, and so is one with Ares's suggestion still waiting on an instance (the User's
//   answer settles it).
// - Each Unfiled instance of a settled series, that no Rule matches and that Ares never proposed a
//   filing for before (so one the User unfiled stays Unfiled), gets a proposal of its own
//   (Organise / "File into Projects", in the Calendar Section) acting on that instance alone: no model
//   and no outside material, so it is not chained. Following the User's filing it is certain;
//   following Ares's own, as sure as an automatic filing. The gate decides it like any other.
import { FILE_INTO_PROJECTS, firstMatch, type Item } from '@commander/domain';
import type { Gate } from '../autonomy/gate';
import type { ItemStore } from '../item-store';

const DAY_MS = 24 * 60 * 60_000;
// The instances this files: from a day ago to the end of what calendar sync keeps.
const DAYS_AHEAD = 366;
// How sure a filing that follows Ares's own automatic one is.
const FOLLOWS_ARES = 0.95;

/** The series an event belongs to, within its Account; null for a one-off event or another Item. */
export const seriesKey = (item: Item): string | null =>
  item.detail?.kind === 'event' && item.detail.seriesId
    ? `${item.account ?? ''}/${item.detail.seriesId}`
    : null;

/** Items grouped by the series they belong to (one-off events and other Items left out). */
export function bySeries(items: readonly Item[]): Map<string, Item[]> {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const key = seriesKey(item);
    if (key) groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

/**
 * How a series' instances are filed: the one Project the User or Ares filed them under, 'mixed' when
 * those filings disagree, 'waiting' while Ares's suggestion waits on an Unfiled instance, or null.
 */
export function seriesFiling(
  instances: readonly Item[],
): { projectId: string; by: 'user' | 'ares' } | 'mixed' | 'waiting' | null {
  if (instances.some((item) => !item.filing && item.filingSuggestion)) return 'waiting';
  const filed = instances.filter(
    (item) => item.filing?.filedBy === 'user' || item.filing?.filedBy === 'ares',
  );
  const projects = new Set(filed.map((item) => item.filing?.projectId));
  if (projects.size > 1) return 'mixed';
  const [first] = filed;
  if (!first?.filing) return null;
  return {
    projectId: first.filing.projectId,
    by: filed.some((item) => item.filing?.filedBy === 'user') ? 'user' : 'ares',
  };
}

export function createSeriesFiling({
  itemStore,
  gate,
  now = Date.now,
}: {
  itemStore: ItemStore;
  gate: Pick<Gate, 'propose'>;
  now?: () => number;
}) {
  const proposedBefore = (itemId: string) =>
    itemStore.autonomy.proposals({ action: FILE_INTO_PROJECTS, itemId, limit: 1 }).length > 0;

  return {
    /** Files the Unfiled instances of every settled series; returns the ones it filed or suggested. */
    run(): string[] {
      const at = now();
      const events = itemStore.events({ from: at - DAY_MS, to: at + DAYS_AHEAD * DAY_MS, limit: 5000 });
      const rules = itemStore.rules();
      const made: string[] = [];
      for (const instances of bySeries(events).values()) {
        const filing = seriesFiling(instances);
        if (!filing || typeof filing === 'string') continue;
        for (const item of instances) {
          if (item.filing || item.detail?.kind !== 'event' || item.detail.createdByCommander) continue;
          if (firstMatch(rules, item) || proposedBefore(item.id)) continue;
          try {
            const outcome = gate.propose({
              action: FILE_INTO_PROJECTS,
              actionKind: 'organise',
              section: 'calendar',
              itemId: item.id,
              itemActions: [
                {
                  type: 'update',
                  itemId: item.id,
                  changes: { filing: { projectId: filing.projectId, filedBy: 'ares' } },
                },
              ],
              confidence: filing.by === 'user' ? 1 : FOLLOWS_ARES,
              reason: `Like the other times of “${item.title.trim()}”`,
            });
            if (outcome.decision !== 'off') made.push(item.id);
          } catch {
            // The gate refused it (the instance changed meanwhile): the next pass looks again.
          }
        }
      }
      return made;
    },
  };
}
