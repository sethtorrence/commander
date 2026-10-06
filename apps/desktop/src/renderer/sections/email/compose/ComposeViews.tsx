import { addressName, type DraftEntry, type OutboxEntry, outboxLine } from '@commander/domain';
import { cn } from '@commander/ui';
import { useNow } from '../../../frame/use-now';
import { threadTime } from '../email';

/*
  The Drafts and Outbox views (#138). Drafts: every draft, Commander's and those made in Gmail or
  Outlook, newest first, each opening in the composer. Outbox: the messages waiting to go, held for
  Undo (with their countdown), waiting for a connection, on their way, or refused with the reason and
  Retry; any not yet on its way can be taken back into the composer.
*/

const smallButton =
  'cursor-pointer border border-line bg-sheet px-2 py-1 font-mono text-label leading-none font-semibold uppercase tracking-caps text-ink hover:bg-raise';

const recipients = (to: { name: string | null; address: string }[]) =>
  to.length ? to.map((each) => addressName(each)).join(', ') : '(no one yet)';

export function DraftList({
  drafts,
  accountName,
  onOpen,
  onDiscard,
}: {
  drafts: DraftEntry[];
  /** The Account's address, when drafts of several Accounts are listed; null otherwise. */
  accountName: (account: string) => string | null;
  onOpen: (itemId: string) => void;
  onDiscard: (itemId: string) => void;
}) {
  const now = useNow(60_000);
  if (!drafts.length)
    return (
      <p className="hatch m-0 border-b border-line2 py-2.5 pr-5 pl-13 text-note text-faint">No drafts.</p>
    );
  return (
    <ul aria-label="Drafts" className="m-0 list-none p-0">
      {drafts.map((draft) => (
        <li
          key={draft.itemId}
          data-testid="email-draft"
          className="flex items-center gap-3 border-b border-line2 py-2.5 pr-4 pl-13"
        >
          <button
            type="button"
            onClick={() => onOpen(draft.itemId)}
            className="min-w-0 flex-1 cursor-pointer border-0 bg-transparent p-0 text-left"
          >
            <span className="flex items-baseline gap-2.5">
              <span className="font-mono text-label font-semibold uppercase tracking-caps text-signal-ink">
                Draft
              </span>
              <span className="min-w-0 truncate text-row font-medium text-ink">{recipients(draft.to)}</span>
              <span className="ml-auto flex-none font-mono text-label text-muted">
                {threadTime(draft.updatedAt, now)}
              </span>
            </span>
            <span className="block truncate text-row text-text">{draft.subject || '(no subject)'}</span>
            <span className="block truncate text-note text-muted">
              {accountName(draft.account) ? `${accountName(draft.account)} · ` : ''}
              {draft.snippet}
            </span>
          </button>
          <button
            type="button"
            className={smallButton}
            aria-label={`Discard ${draft.subject || 'draft'}`}
            onClick={() => onDiscard(draft.itemId)}
          >
            Discard
          </button>
        </li>
      ))}
    </ul>
  );
}

/** How an Outbox entry stands, with what can be done about it. */
export function OutboxNote({
  entry,
  onUndo,
  onRetry,
  className,
}: {
  entry: OutboxEntry;
  onUndo: () => void;
  onRetry: () => void;
  className?: string;
}) {
  const now = useNow(1_000);
  return (
    <div
      data-testid="outbox-note"
      data-state={entry.state}
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-3 font-mono text-label uppercase tracking-label',
        className,
      )}
    >
      <span className={cn('normal-case', entry.state === 'failed' ? 'font-semibold text-ink' : 'text-muted')}>
        {outboxLine(entry, now.getTime())}
      </span>
      {entry.state !== 'sending' && (
        <button type="button" className={smallButton} onClick={onUndo}>
          {entry.state === 'held' ? 'Undo' : 'Cancel'}
        </button>
      )}
      {entry.state === 'failed' && (
        <button type="button" className={smallButton} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function OutboxList({
  outbox,
  onUndo,
  onRetry,
}: {
  outbox: OutboxEntry[];
  onUndo: (itemId: string) => void;
  onRetry: (itemId: string) => void;
}) {
  if (!outbox.length)
    return (
      <p className="hatch m-0 border-b border-line2 py-2.5 pr-5 pl-13 text-note text-faint">
        Nothing waiting to send.
      </p>
    );
  return (
    <ul aria-label="Outbox" className="m-0 list-none p-0">
      {outbox.map((entry) => (
        <li key={entry.itemId} data-testid="outbox-entry" className="border-b border-line2 py-2.5 pr-4 pl-13">
          <span className="block truncate text-row font-medium text-ink">To {recipients(entry.to)}</span>
          <span className="block truncate text-row text-text">{entry.subject || '(no subject)'}</span>
          <OutboxNote
            entry={entry}
            className="mt-1"
            onUndo={() => onUndo(entry.itemId)}
            onRetry={() => onRetry(entry.itemId)}
          />
        </li>
      ))}
    </ul>
  );
}
