import type { Item } from '@commander/domain';
import { useEffect, useMemo, useState } from 'react';
import type { ItemChanges } from '../item-store/changes';
import type { ItemStoreClient } from '../item-store/client';

/*
  Calendar events for `[[` links (#128): those the meeting chips and event links on screen point at
  (tombstones too, so a cancelled meeting's card can say so), and those the `[[` picker offers (the
  last 30 days to 90 days ahead). Read again when the Items on screen change, when the Core says the
  meeting chips changed, and when `active` comes back.
*/

export interface EventLookup {
  /** Events by id: those linked on screen and those offered. */
  byId: ReadonlyMap<string, Item>;
  /** What the `[[` picker offers. */
  offered: readonly Item[];
}

const DAY = 24 * 60 * 60_000;
const MOST = 1000;

export function useEvents(
  itemStore: ItemStoreClient,
  linkedIds: readonly string[],
  {
    changes,
    meetingChips,
    active = true,
    now = Date.now,
  }: {
    changes?: ItemChanges;
    /** Hears the Core's word that today's meeting chips changed. Returns the stop function. */
    meetingChips?: (listener: () => void) => () => void;
    active?: boolean;
    now?: () => number;
  } = {},
): EventLookup {
  const [linked, setLinked] = useState<readonly Item[]>([]);
  const [offered, setOffered] = useState<readonly Item[]>([]);
  const [version, setVersion] = useState(0);
  const key = [...new Set(linkedIds)].sort().join(',');

  // The events the picker offers: read when shown, and when the chips change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks again
  useEffect(() => {
    if (!active) return;
    let current = true;
    const at = now();
    itemStore({ op: 'events', query: { from: at - 30 * DAY, to: at + 90 * DAY, limit: 2000 } }).then(
      (found) => current && setOffered(found),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [itemStore, active, version, now]);

  // The events linked on screen, tombstones included.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the ids, `version` asks again
  useEffect(() => {
    const ids = key ? key.split(',').slice(0, MOST) : [];
    if (!ids.length) {
      setLinked([]);
      return;
    }
    let current = true;
    itemStore({ op: 'query', query: { ids, kinds: ['event'], includeDeleted: true, limit: MOST } }).then(
      (found) => current && setLinked(found),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [itemStore, key, version]);

  // An event on screen changed (a sync moved or cancelled it, the User filed it), or the chips did.
  useEffect(() => {
    const wanted = new Set(key ? key.split(',') : []);
    const stops = [
      changes?.((itemIds) => {
        if (itemIds.some((id) => wanted.has(id))) setVersion((v) => v + 1);
      }),
      meetingChips?.(() => setVersion((v) => v + 1)),
    ];
    return () => {
      for (const stop of stops) stop?.();
    };
  }, [changes, meetingChips, key]);

  return useMemo(() => {
    const byId = new Map<string, Item>();
    for (const event of offered) byId.set(event.id, event);
    for (const event of linked) byId.set(event.id, event);
    return { byId, offered };
  }, [linked, offered]);
}
