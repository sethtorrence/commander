import { type ProposalRecord, SKIP_THE_INBOX } from '@commander/domain';
import { Button, toast } from '@commander/ui';
import { useCallback, useEffect, useState } from 'react';
import type { ItemChanges } from '../../item-store/changes';
import type { AutonomyClient } from '../ares/activity';

/*
  Skip the inbox in the Email Section (#142): Ares's suggestions to archive mail a Rule or Ares sorted
  into a Bucket that skips the inbox (Tidy your Sources, Ask by default), read from the gate. Each
  shows on its email (a mark on the row, and Archive or Not now in the open thread), and the Bucket
  view groups them ("Archive 8 Newsletters?") with Accept all, whose toast has Undo.
*/

export type SkipSuggestion = { id: number; itemId: string; reason: string };

export interface SkipSuggestions {
  /** Waiting suggestions, by the email (message) they are on. */
  byItem: ReadonlyMap<string, SkipSuggestion>;
  /** Accepts these suggestions (archiving their emails), all at once; resolves with what was done. */
  accept(proposalIds: number[]): Promise<ProposalRecord[]>;
  dismiss(proposalIds: number[]): Promise<void>;
  /** Undoes what accepted suggestions did (the emails back in the inbox). */
  undo(proposalIds: number[]): Promise<void>;
}

const none = new Map<string, SkipSuggestion>();

/**
 * The waiting Skip the inbox suggestions, read again whenever Ares does or suggests something, an
 * email changes, or one is accepted or dismissed here. Without the gate's client, there are none.
 */
export function useSkipSuggestions(
  autonomy: AutonomyClient | undefined,
  changes: ItemChanges,
  onAresActivity?: (listener: () => void) => () => void,
  onDone?: () => void,
): SkipSuggestions {
  const [byItem, setByItem] = useState<ReadonlyMap<string, SkipSuggestion>>(none);
  const reload = useCallback(async () => {
    if (!autonomy) return;
    try {
      const rows = await autonomy({
        op: 'activity',
        query: { action: SKIP_THE_INBOX, statuses: ['pending'] },
      });
      setByItem(
        new Map(rows.map((row) => [row.itemId, { id: row.id, itemId: row.itemId, reason: row.reason }])),
      );
    } catch {
      // Left as they were; the next change reads them again.
    }
  }, [autonomy]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => onAresActivity?.(() => void reload()), [onAresActivity, reload]);
  useEffect(() => changes(() => void reload()), [changes, reload]);

  const after = async <T,>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } finally {
      await reload();
      onDone?.();
    }
  };

  return {
    byItem,
    accept: (proposalIds) =>
      after(async () => {
        if (!autonomy || !proposalIds.length) return [];
        return autonomy({ op: 'accept-all', proposalIds });
      }),
    dismiss: (proposalIds) =>
      after(async () => {
        for (const proposalId of proposalIds) await autonomy?.({ op: 'dismiss', proposalId });
      }),
    undo: (proposalIds) =>
      after(async () => {
        for (const proposalId of proposalIds) await autonomy?.({ op: 'undo', proposalId });
      }),
  };
}

/** The suggestions on a thread's messages. */
export const suggestionsOn = (byItem: ReadonlyMap<string, SkipSuggestion>, itemIds: readonly string[]) =>
  itemIds.flatMap((itemId) => byItem.get(itemId) ?? []);

const plural = (count: number, name: string) => `${count} ${count === 1 ? name.replace(/s$/, '') : name}`;

/** The Bucket view's offer: "Archive 8 Newsletters?" with Accept all, whose toast has Undo. */
export function SkipInboxOffer({
  bucket,
  threads,
  proposalIds,
  suggestions,
}: {
  bucket: string;
  threads: number;
  proposalIds: number[];
  suggestions: SkipSuggestions;
}) {
  const [busy, setBusy] = useState(false);
  const acceptAll = async () => {
    setBusy(true);
    try {
      const done = await suggestions.accept(proposalIds);
      const ids = done.map((record) => record.id);
      toast(`Archived ${plural(threads, bucket)}`, {
        action: { label: 'Undo', onClick: () => void suggestions.undo(ids) },
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-label="Skip the inbox"
      className="flex items-center gap-3 border-b border-line bg-signal-focus py-2 pr-3.5 pl-13 text-note text-ink"
    >
      <span className="min-w-0 flex-1">
        <b>Archive {plural(threads, bucket)}?</b> {bucket} skips the inbox: Ares suggests archiving{' '}
        {threads === 1 ? 'it' : 'them'} in Gmail or Outlook.
      </span>
      <Button disabled={busy} onClick={() => void suggestions.dismiss(proposalIds)}>
        Not now
      </Button>
      <Button variant="primary" disabled={busy} onClick={() => void acceptAll()}>
        Accept all
      </Button>
    </section>
  );
}

/** The suggestion on the open thread: Archive (accepting it) or Not now (dismissing it). */
export function SkipInboxSuggestion({
  found,
  suggestions,
}: {
  found: SkipSuggestion[];
  suggestions: SkipSuggestions;
}) {
  const ids = found.map((each) => each.id);
  return (
    <section
      aria-label="Ares’s suggestion"
      className="mt-4 flex items-center gap-3 border border-dashed border-ink px-3 py-2 text-note text-ink"
    >
      <span className="min-w-0 flex-1">Ares suggests archiving this: {found[0]?.reason}.</span>
      <Button onClick={() => void suggestions.dismiss(ids)}>Not now</Button>
      <Button
        variant="primary"
        onClick={() =>
          void suggestions.accept(ids).then(
            (done) =>
              toast('Archived', {
                action: { label: 'Undo', onClick: () => void suggestions.undo(done.map((each) => each.id)) },
              }),
            (error: unknown) => toast(error instanceof Error ? error.message : String(error)),
          )
        }
      >
        Archive
      </Button>
    </section>
  );
}

/** A thread row's mark: Ares suggests archiving it. */
export function SkipInboxMark() {
  return (
    <span
      title="Ares suggests archiving this: its Bucket skips the inbox"
      className="inline-flex h-5 flex-none items-center border border-dashed border-ink px-[7px] font-mono text-label leading-none font-semibold uppercase tracking-label text-ink"
    >
      Archive?
    </span>
  );
}
