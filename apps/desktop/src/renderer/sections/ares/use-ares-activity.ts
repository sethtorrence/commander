import type { ActionKind, AresActivity } from '@commander/domain';
import { toast } from '@commander/ui';
import { useCallback, useEffect, useState } from 'react';
import type { AresActivityFilters, AutonomyClient } from './activity';

export interface AresActivityState {
  /** Newest first; null until the first load. */
  rows: AresActivity[] | null;
  accept(proposalId: number): Promise<void>;
  dismiss(proposalId: number): Promise<void>;
  /** Accepts every waiting suggestion of one kind on the page (Organise and Tidy your Sources only). */
  acceptAll(kind: ActionKind): Promise<void>;
  undo(proposalId: number): Promise<void>;
}

/**
 * Ares's activity, kept in step with the gate: reloaded when the filters change, when the page is
 * shown, after every change made here, and whenever the Core says Ares did or suggested something
 * (`onAresActivity`). Failures are shown as a toast.
 */
export function useAresActivity(
  client: AutonomyClient,
  filters: AresActivityFilters,
  shown: boolean,
  onAresActivity?: (listener: () => void) => () => void,
): AresActivityState {
  const [rows, setRows] = useState<AresActivity[] | null>(null);
  const [version, setVersion] = useState(0);
  const changed = useCallback(() => setVersion((v) => v + 1), []);
  const { actionKind, section } = filters;

  useEffect(() => onAresActivity?.(changed), [onAresActivity, changed]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload after a change
  useEffect(() => {
    if (!shown) return;
    let current = true;
    const query = { ...(actionKind && { actionKinds: [actionKind] }), ...(section && { section }) };
    client({ op: 'activity', query }).then((next) => current && setRows(next), report);
    return () => {
      current = false;
    };
  }, [client, actionKind, section, shown, version]);

  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        report(error);
      }
      changed();
    },
    [changed],
  );

  return {
    rows,
    accept: (proposalId) => run(() => client({ op: 'accept', proposalId })),
    dismiss: (proposalId) => run(() => client({ op: 'dismiss', proposalId })),
    acceptAll: (kind) => {
      const proposalIds = (rows ?? [])
        .filter((row) => row.status === 'pending' && row.actionKind === kind)
        .map((row) => row.id);
      if (!proposalIds.length) return Promise.resolve();
      return run(() => client({ op: 'accept-all', proposalIds }));
    },
    undo: (proposalId) => run(() => client({ op: 'undo', proposalId })),
  };
}

function report(error: unknown) {
  toast(error instanceof Error ? error.message : String(error));
}
