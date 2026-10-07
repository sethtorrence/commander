import type { OutgoingEntry } from '@commander/domain';
import type { AccountSummary } from '@commander/domain/ipc';
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  toast,
} from '@commander/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { requestReveal } from '../frame/reveal';
import { useNow } from '../frame/use-now';
import { useOpenSection } from '../sections/section';
import {
  changeState,
  describeOutgoing,
  MESSAGE_PLACES,
  madeWhen,
  type OutgoingChangesClient,
  outgoingChangesIn,
} from './outgoing-changes';

// An Account's changes that didn't reach its Source (#206), beside its sync status in Settings →
// Accounts: how many are waiting and how many couldn't sync, and (opened) each change with what it
// was, on which Item, when, and why it stopped, with Retry and Discard. Discard puts the Item back as
// the Source has it, after a confirmation, as it can't be undone. A message written in Commander opens
// the Outbox, Scheduled or Drafts instead, which have their own Retry and Undo.

const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

// The window's Item store channel, where there is one (component tests may run without it).
function windowClient(): OutgoingChangesClient | null {
  const bridge = window.commander as Partial<Window['commander']> | undefined;
  return bridge?.itemStore ? outgoingChangesIn(bridge.itemStore) : null;
}

function DiscardChange({ entry, onDiscard }: { entry: OutgoingEntry; onDiscard: () => void }) {
  const [open, setOpen] = useState(false);
  const item = entry.item.label ?? `“${entry.item.title}”`;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="ghost" aria-label={`Discard: ${entry.what}`} onClick={() => setOpen(true)}>
        Discard
      </Button>
      <DialogContent aria-describedby={undefined} data-testid="discard-change-dialog">
        <DialogHeader>
          <DialogTitle>Discard change</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogHeading>Discard “{entry.what}”?</DialogHeading>
          <DialogDescription>
            {item} goes back to what the Source has, and the change isn’t sent. This can’t be undone; make the
            change again if you still want it.
          </DialogDescription>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button
            variant="primary"
            onClick={() => {
              onDiscard();
              setOpen(false);
            }}
          >
            Discard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function OutgoingChanges({
  account,
  client: given,
}: {
  account: AccountSummary;
  client?: OutgoingChangesClient | null;
}) {
  const client = useMemo(() => (given === undefined ? windowClient() : given), [given]);
  const openSection = useOpenSection();
  const now = useNow(30_000);
  const counts = account.sync?.outgoing ?? { pending: 0, failed: 0 };
  const summary = describeOutgoing(counts);
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<OutgoingEntry[] | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // Read again whenever it opens, the counts move (a change went, or stopped) or an action was taken.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the counts and `version` ask for a reload
  useEffect(() => {
    if (!open || !client) return;
    let current = true;
    client.entries(account.id).then(
      (next) => current && setEntries(next),
      (reason) => toast(errorText(reason)),
    );
    return () => {
      current = false;
    };
  }, [open, client, account.id, counts.pending, counts.failed, version]);

  if (!summary || !client) return null;
  const act = (run: () => Promise<unknown>) =>
    run().then(reload, (reason) => {
      toast(errorText(reason));
      reload();
    });
  const failed = (entries ?? []).filter((entry) => entry.status === 'failed' && !entry.message);

  return (
    <div data-testid="account-outgoing" className="mt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          data-testid="account-outgoing-counts"
          className="font-mono text-label-lg leading-[1.4] uppercase tracking-tag text-ink"
        >
          {summary}
        </span>
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          {open ? 'Hide changes' : 'Show changes'}
        </Button>
        {open && failed.length > 1 && (
          <Button size="sm" onClick={() => act(() => client.retry(failed.map((entry) => entry.id)))}>
            Retry all {failed.length}
          </Button>
        )}
      </div>
      {open && (
        <ul
          aria-label={`Changes waiting to reach ${account.name}`}
          className="m-0 mt-2 list-none border-l border-line2 p-0 pl-3"
        >
          {entries === null ? (
            <li className="py-1 text-note text-muted">Loading…</li>
          ) : (
            entries.map((entry) => {
              const place = entry.message ? MESSAGE_PLACES[entry.message] : null;
              return (
                <li
                  key={entry.id}
                  data-testid="outgoing-change"
                  aria-label={`${entry.what} · ${entry.item.label ?? entry.item.title}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-line2 py-1.5 text-note leading-5 last:border-b-0"
                >
                  <span className="min-w-0">
                    <b className="font-semibold text-ink">{entry.what}</b>
                    <span className="text-muted"> · </span>
                    {entry.item.label && (
                      <span className="mr-1.5 font-mono text-label font-semibold tracking-label text-ink">
                        {entry.item.label}
                      </span>
                    )}
                    <span className="text-ink">{entry.item.title}</span>
                    <span data-testid="outgoing-change-state" className="block text-muted">
                      {changeState(entry)} · {madeWhen(entry, now)}
                      {entry.error && ` · ${entry.error}`}
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    {entry.status === 'failed' && (
                      <Button
                        size="sm"
                        aria-label={`Retry: ${entry.what}`}
                        onClick={() => act(() => client.retry([entry.id]))}
                      >
                        Retry
                      </Button>
                    )}
                    {place ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          openSection('email');
                          requestReveal('email', '', place.focus);
                        }}
                      >
                        {place.label}
                      </Button>
                    ) : (
                      entry.status !== 'sending' && (
                        <DiscardChange
                          entry={entry}
                          onDiscard={() => act(() => client.discard([entry.id]))}
                        />
                      )
                    )}
                  </span>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
