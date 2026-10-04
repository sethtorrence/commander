import type { AresActivity } from '@commander/domain';
import { toast } from '@commander/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AutonomyClient } from '../ares/activity';

/*
  Ares's suggestions for Blocks, shown as cards in the margin of the Daily Note (Ask, or when he isn't
  sure): each a Todo he would add for the Block, with his reason, and Add (the User accepts it through
  the gate) or Dismiss (for good: he doesn't offer it again for the same text). Read from the gate's
  pending suggestions in Notes, again whenever the Core says Ares did or suggested something.
*/

export interface MarginSuggestion {
  /** The suggestion (the gate's proposal) id. */
  id: number;
  blockId: string;
  /** The Todo's title. */
  title: string;
  reason: string;
}

/** A pending suggestion in Notes that would add a Todo for a Block, as its margin card shows it. */
export function marginSuggestionOf(row: AresActivity): MarginSuggestion | null {
  if (row.status !== 'pending' || row.item?.kind !== 'block') return null;
  const create = row.itemActions.find((action) => action.type === 'create' && action.item.kind === 'todo');
  if (create?.type !== 'create') return null;
  return { id: row.id, blockId: row.itemId, title: create.item.title, reason: row.reason };
}

export interface MarginSuggestions {
  /** Oldest first, by the Block they are for. */
  byBlock: ReadonlyMap<string, MarginSuggestion[]>;
  add(id: number): Promise<void>;
  dismiss(id: number): Promise<void>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function useMarginSuggestions(
  client: AutonomyClient,
  onAresActivity: (listener: () => void) => () => void,
  shown: boolean,
): MarginSuggestions {
  const [rows, setRows] = useState<MarginSuggestion[]>([]);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => onAresActivity(reload), [onAresActivity, reload]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload
  useEffect(() => {
    if (!shown) return;
    let current = true;
    client({ op: 'activity', query: { section: 'notes', statuses: ['pending'], limit: 500 } }).then(
      (activity) => {
        if (!current) return;
        const found = activity.map(marginSuggestionOf).filter((row): row is MarginSuggestion => row !== null);
        setRows(found.reverse());
      },
      (error) => toast(message(error)),
    );
    return () => {
      current = false;
    };
  }, [client, shown, version]);

  const byBlock = useMemo(() => {
    const map = new Map<string, MarginSuggestion[]>();
    for (const row of rows) map.set(row.blockId, [...(map.get(row.blockId) ?? []), row]);
    return map;
  }, [rows]);

  const settle = useCallback(
    async (id: number, op: 'accept' | 'dismiss') => {
      // The card goes at once; a failure brings it back with the reason.
      setRows((was) => was.filter((row) => row.id !== id));
      try {
        await client({ op, proposalId: id });
      } catch (error) {
        toast(message(error));
      }
      reload();
    },
    [client, reload],
  );

  return {
    byBlock,
    add: (id) => settle(id, 'accept'),
    dismiss: (id) => settle(id, 'dismiss'),
  };
}
