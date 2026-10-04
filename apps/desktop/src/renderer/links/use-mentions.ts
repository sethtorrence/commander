import type { LinkTarget, Mention } from '@commander/domain';
import { toast } from '@commander/ui';
import { useEffect, useMemo, useState } from 'react';
import type { ItemChanges } from '../item-store/changes';
import type { ItemStoreClient } from '../item-store/client';

/*
  "Mentioned in", read from the Item store: the Blocks whose `[[` links point at a Project, or at
  days' Daily Notes. Read again whenever the Core says Items changed (a Block written anywhere may
  have gained or lost a link), a moment after the last change.
*/

const SETTLE_MS = 250;

// Calls `reload` now, and again shortly after each burst of Item changes. Returns the stop function.
function reloadOnChanges(reload: () => void, changes: ItemChanges | undefined): () => void {
  reload();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = changes?.(() => {
    clearTimeout(timer);
    timer = setTimeout(reload, SETTLE_MS);
  });
  return () => {
    clearTimeout(timer);
    stop?.();
  };
}

const report = (error: unknown) => toast(error instanceof Error ? error.message : String(error));

/** The Blocks mentioning a Project, newest day first. */
export function useProjectMentions(
  itemStore: ItemStoreClient,
  projectId: string,
  changes?: ItemChanges,
  reloadWhen?: unknown,
): Mention[] {
  const [mentions, setMentions] = useState<Mention[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloadWhen` asks for a reload
  useEffect(() => {
    let current = true;
    const target: LinkTarget = { targetType: 'project', id: projectId };
    const reload = () =>
      itemStore({ op: 'mentions', query: { targets: [target] } }).then(
        (found) => current && setMentions(found),
        report,
      );
    const stop = reloadOnChanges(reload, changes);
    return () => {
      current = false;
      stop();
    };
  }, [itemStore, projectId, changes, reloadWhen]);
  return mentions;
}

/**
 * The Blocks on other days mentioning each of these days, by day (YYYY-MM-DD). A day with a Daily
 * Note made only as a link's target counts too.
 */
export function useDayMentions(
  itemStore: ItemStoreClient,
  days: readonly string[],
  changes?: ItemChanges,
): ReadonlyMap<string, Mention[]> {
  const [byDay, setByDay] = useState<ReadonlyMap<string, Mention[]>>(new Map());
  const key = useMemo(() => [...days].sort().join(','), [days]);
  useEffect(() => {
    const wanted = key ? key.split(',') : [];
    if (!wanted.length) return;
    let current = true;
    const reload = async () => {
      const from = wanted[0] as string;
      const to = wanted.at(-1) as string;
      // Every Daily Note in the range, empty ones included: a day ahead may be one only as a target.
      const page = await itemStore({ op: 'daily-notes', query: { from, to, limit: 1000 } });
      const dayOf = new Map(
        page.notes.filter((note) => wanted.includes(note.day)).map((note) => [note.item.id, note.day]),
      );
      const targets = [...dayOf.keys()].map((id): LinkTarget => ({ targetType: 'item', id }));
      const found = targets.length ? await itemStore({ op: 'mentions', query: { targets } }) : [];
      const next = new Map<string, Mention[]>();
      for (const mention of found) {
        const day = dayOf.get(mention.target.id);
        // A Block mentioning its own day isn't news on that day's sheet.
        if (!day || mention.day === day) continue;
        next.set(day, [...(next.get(day) ?? []), mention]);
      }
      if (current) setByDay(next);
    };
    const stop = reloadOnChanges(() => void reload().catch(report), changes);
    return () => {
      current = false;
      stop();
    };
  }, [itemStore, key, changes]);
  return byDay;
}
