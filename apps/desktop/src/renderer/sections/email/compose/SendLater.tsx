import {
  addressName,
  HELD_BY_MICROSOFT_NOTE,
  HELD_BY_NAMES,
  heldByFor,
  localDateTime,
  type ScheduledEntry,
  SEND_LATER_NOTICE,
  scheduledLine,
  sendLaterChoices,
  sendLaterProblem,
  sendLaterTime,
} from '@commander/domain';
import {
  Button,
  cn,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from '@commander/ui';
import { useState } from 'react';
import { useNow } from '../../../frame/use-now';

/*
  Send later (#139): the menu of send times (Later today, Tomorrow morning, Monday morning, or a picked
  date and time), shown from the composer's Send later and from Scheduled's Change time; and the
  Scheduled view, every scheduled message with its time, Account and who holds it, with Edit, Change
  time, Send now and Cancel. Every time a time is picked for an Account Commander sends from (Gmail,
  personal Outlook.com), it says Ares has to be running then; an Outlook work Account's mail Microsoft
  holds, so it says that instead.
*/

const smallButton =
  'cursor-pointer border border-line bg-sheet px-2 py-1 font-mono text-label leading-none font-semibold uppercase tracking-caps text-ink hover:bg-raise';

/** What picking a time for this Account means: the running notice, or that Microsoft holds it. */
export function SendLaterNote({ account, className }: { account: string; className?: string }) {
  const microsoft = heldByFor(account) === 'microsoft';
  return (
    <p
      data-testid={microsoft ? 'send-later-held' : 'send-later-notice'}
      className={cn('m-0 text-note', microsoft ? 'text-muted' : 'font-semibold text-ink', className)}
    >
      {microsoft ? HELD_BY_MICROSOFT_NOTE : SEND_LATER_NOTICE}
    </p>
  );
}

export function SendLaterPicker({
  account,
  title = 'Send later',
  initial,
  onPick,
  onClose,
}: {
  /** The Account it goes from: who holds it until then. */
  account: string;
  title?: string;
  /** The time already chosen, if any (Change time). */
  initial?: number | null;
  onPick: (at: number) => void;
  onClose: () => void;
}) {
  const now = Date.now();
  const choices = sendLaterChoices(now);
  const [picked, setPicked] = useState(() => localDateTime(initial ?? choices[0]?.at ?? now + 3_600_000));
  const [error, setError] = useState<string | null>(null);
  const pickTyped = () => {
    const at = new Date(picked).getTime();
    const problem = sendLaterProblem(at, Date.now());
    if (problem) {
      setError(problem);
      return;
    }
    onPick(at);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(440px,calc(100vw-48px))]" data-testid="send-later-picker">
        <DialogHeader partNumber="EML-L">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogDescription className="sr-only">When the message goes</DialogDescription>
        <DialogBody className="flex flex-col gap-3">
          <ul className="m-0 flex list-none flex-col p-0">
            {choices.map((choice) => (
              <li key={choice.label} className="border-b border-line2">
                <button
                  type="button"
                  onClick={() => onPick(choice.at)}
                  className="flex w-full cursor-pointer items-center justify-between gap-3 border-0 bg-transparent px-1 py-2 text-left text-row text-ink hover:bg-raise"
                >
                  {choice.label}
                  <span className="font-mono text-label uppercase tracking-label text-muted">
                    {sendLaterTime(choice.at, now)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-end gap-2">
            <label
              htmlFor="send-later-picked"
              className="flex min-w-0 flex-1 flex-col gap-1 font-mono text-label uppercase tracking-label text-muted"
            >
              Date and time
              <Input
                id="send-later-picked"
                type="datetime-local"
                value={picked}
                onChange={(event) => {
                  setPicked(event.target.value);
                  setError(null);
                }}
              />
            </label>
            <Button onClick={pickTyped}>Pick this time</Button>
          </div>
          {error && <p className="m-0 text-note font-semibold text-ink">{error}</p>}
          <SendLaterNote account={account} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

const recipients = (to: ScheduledEntry['to']) =>
  to.length ? to.map((each) => addressName(each)).join(', ') : '(no one yet)';

/** Scheduled: every scheduled message, soonest first, with what can be done about it. */
export function ScheduledList({
  scheduled,
  accountName,
  onEdit,
  onReschedule,
  onSendNow,
  onCancel,
  onRetry,
}: {
  scheduled: ScheduledEntry[];
  /** The Account's address. */
  accountName: (account: string) => string;
  onEdit: (itemId: string) => void;
  onReschedule: (itemId: string, sendAt: number) => void;
  onSendNow: (itemId: string) => void;
  onCancel: (itemId: string) => void;
  onRetry: (itemId: string) => void;
}) {
  const now = useNow(60_000).getTime();
  const [changing, setChanging] = useState<ScheduledEntry | null>(null);
  if (!scheduled.length)
    return (
      <p className="hatch m-0 border-b border-line2 py-2.5 pr-5 pl-13 text-note text-faint">
        Nothing scheduled. Pick Send later in the composer to send a message at a time you choose.
      </p>
    );
  return (
    <>
      <ul aria-label="Scheduled" className="m-0 list-none p-0">
        {scheduled.map((entry) => (
          <li
            key={entry.itemId}
            data-testid="scheduled-entry"
            data-state={entry.state}
            data-held-by={entry.heldBy}
            aria-label={entry.subject || '(no subject)'}
            className="border-b border-line2 py-2.5 pr-4 pl-13"
          >
            <span className="flex items-baseline gap-2.5">
              <span
                className={cn(
                  'font-mono text-label font-semibold uppercase tracking-caps',
                  entry.state === 'missed' || entry.state === 'failed' ? 'text-ink' : 'text-signal-ink',
                )}
              >
                {entry.state === 'missed' ? 'Missed' : 'Scheduled'}
              </span>
              <span className="min-w-0 truncate text-row font-medium text-ink">
                To {recipients(entry.to)}
              </span>
              <span
                data-testid="scheduled-time"
                className="ml-auto flex-none font-mono text-label text-muted"
              >
                {sendLaterTime(entry.sendAt, now)}
              </span>
            </span>
            <span className="block truncate text-row text-text">{entry.subject || '(no subject)'}</span>
            <span className="block truncate text-note text-muted">
              {accountName(entry.account)} ·{' '}
              <span data-testid="scheduled-held-by">{HELD_BY_NAMES[entry.heldBy]}</span>
            </span>
            {(entry.state === 'missed' || entry.state === 'handing' || entry.state === 'failed') && (
              <span data-testid="scheduled-line" className="block text-note text-ink">
                {scheduledLine(entry, now)}
              </span>
            )}
            <span className="mt-1.5 flex flex-wrap gap-1.5">
              <button type="button" className={smallButton} onClick={() => onEdit(entry.itemId)}>
                Edit
              </button>
              <button type="button" className={smallButton} onClick={() => setChanging(entry)}>
                Change time
              </button>
              <button type="button" className={smallButton} onClick={() => onSendNow(entry.itemId)}>
                Send now
              </button>
              <button type="button" className={smallButton} onClick={() => onCancel(entry.itemId)}>
                Cancel
              </button>
              {entry.state === 'failed' && (
                <button type="button" className={smallButton} onClick={() => onRetry(entry.itemId)}>
                  Retry
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {changing && (
        <SendLaterPicker
          account={changing.account}
          title="Change time"
          initial={changing.sendAt > now ? changing.sendAt : null}
          onClose={() => setChanging(null)}
          onPick={(at) => {
            setChanging(null);
            onReschedule(changing.itemId, at);
          }}
        />
      )}
    </>
  );
}
