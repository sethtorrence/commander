import type { Item } from '@commander/domain';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ItemChanges } from '../item-store/changes';
import type { ItemStoreClient } from '../item-store/client';

/*
  Emails for `[[` links (#135): those the email chips on screen point at (tombstones too, so a card
  can say the email is gone), and those the `[[` picker offers (the newest message of the newest
  threads in the inbox and the archive; the picker leaves out Trash). Read again when an email on
  screen or offered changes, when `active` comes back, and, for mail that has just arrived, on any
  change once the offer is a minute old.
*/

export interface EmailLookup {
  /** Emails by id: those linked on screen and those offered. */
  byId: ReadonlyMap<string, Item>;
  /** What the `[[` picker offers. */
  offered: readonly Item[];
}

const MOST = 1000;
// Threads read from each of the inbox and the archive.
const THREADS = 500;
// How old the offer may get before any change reads it again.
const STALE = 60_000;

export function useEmails(
  itemStore: ItemStoreClient,
  linkedIds: readonly string[],
  {
    changes,
    active = true,
    now = Date.now,
  }: { changes?: ItemChanges; active?: boolean; now?: () => number } = {},
): EmailLookup {
  const [linked, setLinked] = useState<readonly Item[]>([]);
  const [offered, setOffered] = useState<readonly Item[]>([]);
  const [version, setVersion] = useState(0);
  const readAt = useRef(0);
  const key = [...new Set(linkedIds)].sort().join(',');

  // The emails the picker offers: each thread's newest message, read when shown.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks again
  useEffect(() => {
    if (!active) return;
    let current = true;
    readAt.current = now();
    Promise.all(
      (['inbox', 'archive'] as const).map((view) =>
        itemStore({ op: 'email-threads', query: { view, limit: THREADS } }),
      ),
    ).then(
      (lists) => {
        if (!current) return;
        const byId = new Map<string, Item>();
        for (const list of lists)
          for (const thread of list.threads) byId.set(thread.latest.id, thread.latest);
        setOffered([...byId.values()]);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [itemStore, active, version, now]);

  // The emails linked on screen, tombstones included.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the ids, `version` asks again
  useEffect(() => {
    const ids = key ? key.split(',').slice(0, MOST) : [];
    if (!ids.length) {
      setLinked([]);
      return;
    }
    let current = true;
    itemStore({ op: 'query', query: { ids, kinds: ['email'], includeDeleted: true, limit: MOST } }).then(
      (found) => current && setLinked(found),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [itemStore, key, version]);

  // An email on screen or offered changed (read, archived, filed, deleted), or mail may have come.
  useEffect(() => {
    if (!changes) return;
    const known = new Set([...(key ? key.split(',') : []), ...offered.map((item) => item.id)]);
    return changes((itemIds) => {
      if (itemIds.some((id) => known.has(id)) || now() - readAt.current > STALE) setVersion((v) => v + 1);
    });
  }, [changes, key, offered, now]);

  return useMemo(() => {
    const byId = new Map<string, Item>();
    for (const email of offered) byId.set(email.id, email);
    for (const email of linked) byId.set(email.id, email);
    return { byId, offered };
  }, [linked, offered]);
}
