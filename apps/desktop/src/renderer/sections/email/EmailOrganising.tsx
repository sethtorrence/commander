import {
  type EmailLabel,
  type EmailListView,
  type EmailThreadSummary,
  type EmailViewCount,
  emailSnoozeChoices,
  gmailSearchUrl,
  type ThreadAction,
} from '@commander/domain';
import type { GoogleAccountSummary } from '@commander/domain/ipc';
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
  Kbd,
} from '@commander/ui';
import { forwardRef, type KeyboardEvent, useState } from 'react';
import type { IssueSync } from '../linear/editing';
import { SNOOZE_NOTE, snoozeTime } from './organising';

/*
  The Email Section's organising parts (#135): the view list, the search box and Gmail's own search
  at the end of results, the marks on a thread's row (starred, labels, snooze), the open thread's
  row of action buttons with its sync state, and the label and snooze pickers.
*/

const caps = 'font-mono text-label leading-none font-semibold uppercase tracking-caps';

/** The views (Inbox, Starred, Snoozed, Archive, Trash, then each label), with their counts. */
export function ViewBar({
  views,
  view,
  searching,
  onView,
}: {
  views: EmailViewCount[];
  view: EmailListView;
  searching: boolean;
  onView: (view: EmailListView) => void;
}) {
  const shown = views.length ? views : [{ view: 'inbox' as const, name: 'Inbox', threads: 0, unread: 0 }];
  return (
    <div className="flex h-[34px] flex-none items-stretch overflow-x-auto border-b border-line">
      <span className="grid w-[41px] flex-none place-items-center border-r border-line2 font-mono text-[8px] leading-none font-semibold tracking-caps text-faint">
        VIEW
      </span>
      <div role="tablist" aria-label="View" className="flex min-w-0 items-stretch">
        {shown.map((each) => {
          const on = !searching && each.view === view;
          // Unread threads, as Gmail counts them; Snoozed and Trash count what they hold.
          const count = each.view === 'snoozed' || each.view === 'trash' ? each.threads : each.unread;
          return (
            <button
              key={each.view}
              type="button"
              role="tab"
              aria-selected={on}
              data-view={each.view}
              onClick={() => onView(each.view)}
              className={cn(
                'flex flex-none cursor-pointer items-center gap-2 border-0 border-r border-line2 px-3.5 whitespace-nowrap',
                caps,
                on ? 'bg-ink text-sheet' : 'bg-transparent text-ink hover:bg-raise',
              )}
            >
              {each.name}
              {count > 0 && <b className={on ? 'text-sheet' : 'text-muted'}>{count}</b>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The Section's search box (`/`): Enter searches, Escape leaves the search. */
export const SearchBox = forwardRef<
  HTMLInputElement,
  { value: string; onChange: (text: string) => void; onSearch: (text: string) => void; onLeave: () => void }
>(function SearchBox({ value, onChange, onSearch, onLeave }, ref) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onSearch(value);
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onLeave();
      event.currentTarget.blur();
    }
  };
  return (
    <input
      ref={ref}
      type="search"
      aria-label="Search mail"
      placeholder="Search mail · from: to: subject: has:attachment is:unread in:"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      className="h-[22px] min-w-0 flex-1 border border-line2 bg-sheet px-2 font-mono text-label normal-case tracking-normal text-ink placeholder:text-faint focus:border-ink focus:outline-none"
    />
  );
});

/** Gmail's own search for the same words, one link per Account, for mail older than Commander downloaded. */
export function GmailSearchLinks({ text, accounts }: { text: string; accounts: GoogleAccountSummary[] }) {
  if (!accounts.length) return null;
  return (
    <div className="border-b border-line2 py-2.5 pr-5 pl-13">
      <p className="m-0 mb-1.5 text-note text-faint">
        Commander keeps the 30 days before an Account was connected and everything since. Older mail is in
        Gmail:
      </p>
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
        {accounts.map((account) => (
          <li key={account.id}>
            <a
              href={gmailSearchUrl(account.email, text)}
              target="_blank"
              rel="noreferrer"
              className={cn(caps, 'text-ink underline-offset-2 hover:underline')}
            >
              Search in Gmail · <span className="normal-case">{account.email}</span> ↗
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StarMark() {
  return (
    <svg
      role="img"
      aria-label="Starred"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 flex-none text-signal-ink"
    >
      <title>Starred</title>
      <path d="M8 1.5 9.9 5.6l4.4.5-3.3 3 .9 4.4L8 11.3l-3.9 2.2.9-4.4-3.3-3 4.4-.5Z" fill="currentColor" />
    </svg>
  );
}

const chip =
  'inline-flex h-5 flex-none items-center border border-line bg-sheet px-[7px] font-mono text-label leading-none font-medium uppercase tracking-label whitespace-nowrap text-muted';

/** A thread row's marks: starred, its labels, and its snooze (waiting, or back from one). */
export function ThreadMarks({ thread, now }: { thread: EmailThreadSummary; now: number }) {
  return (
    <>
      {thread.starred && <StarMark />}
      {thread.snoozedUntil ? (
        <span className={chip}>Until {snoozeTime(thread.snoozedUntil, now)}</span>
      ) : thread.returnedFrom ? (
        <span className={cn(chip, 'border-ink text-ink')}>
          Snoozed until {snoozeTime(thread.returnedFrom, now)}
        </span>
      ) : null}
      {(thread.labels ?? []).map((label) => (
        <span key={label.id} className={cn(chip, 'normal-case')}>
          {label.name}
        </span>
      ))}
    </>
  );
}

function ActionButton({ label, keys, onClick }: { label: string; keys: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-keyshortcuts={keys}
      className={cn(
        'flex flex-none cursor-pointer items-center gap-1.5 border-0 border-r border-line2 bg-transparent px-2.5 text-ink hover:bg-raise',
        caps,
      )}
    >
      {label} <Kbd>{keys.replace('Shift+', '⇧')}</Kbd>
    </button>
  );
}

/**
 * The open thread's row of actions (each also a key), and whether its changes reached Gmail: on
 * their way, or Couldn't sync with Retry.
 */
export function ThreadActions({
  thread,
  view,
  sync,
  superseded,
  onAct,
  onLabels,
  onSnooze,
  onRetry,
}: {
  thread: EmailThreadSummary;
  view: EmailListView;
  sync: IssueSync;
  /** The note when a change made in Gmail won over the User's. */
  superseded?: string | null;
  onAct: (action: ThreadAction) => void;
  onLabels: () => void;
  onSnooze: () => void;
  onRetry: () => void;
}) {
  const inTrash = view === 'trash' || !!thread.inTrash;
  const unread = thread.unreadCount > 0;
  return (
    <div
      role="toolbar"
      aria-label="Thread actions"
      className="flex min-w-0 flex-initial items-stretch overflow-x-auto [scrollbar-width:none]"
    >
      {inTrash ? (
        <ActionButton label="Move to inbox" keys="e" onClick={() => onAct({ type: 'move-to-inbox' })} />
      ) : (
        <>
          {view === 'archive' ? (
            <ActionButton label="Move to inbox" keys="e" onClick={() => onAct({ type: 'move-to-inbox' })} />
          ) : (
            <ActionButton label="Archive" keys="e" onClick={() => onAct({ type: 'archive' })} />
          )}
          <ActionButton label="Trash" keys="#" onClick={() => onAct({ type: 'trash' })} />
        </>
      )}
      <ActionButton
        label={thread.starred ? 'Unstar' : 'Star'}
        keys="s"
        onClick={() => onAct({ type: thread.starred ? 'unstar' : 'star' })}
      />
      {unread ? (
        <ActionButton label="Mark read" keys="Shift+I" onClick={() => onAct({ type: 'read' })} />
      ) : (
        <ActionButton label="Mark unread" keys="Shift+U" onClick={() => onAct({ type: 'unread' })} />
      )}
      <ActionButton label="Labels" keys="l" onClick={onLabels} />
      <ActionButton label={thread.snoozedUntil ? 'Snoozed' : 'Snooze'} keys="z" onClick={onSnooze} />
      <span role="status" className="ml-auto flex flex-none items-center gap-2 px-3.5 text-note">
        {sync.kind === 'synced' && superseded && <span className="text-muted">{superseded}</span>}
        {sync.kind === 'sending' && <span className="text-faint">Sending to Gmail…</span>}
        {sync.kind === 'failed' && (
          <>
            <span className="font-semibold text-ink" title={sync.error ?? undefined}>
              Couldn’t sync{sync.error ? `: ${sync.error}` : ''}
            </span>
            <Button size="sm" onClick={onRetry}>
              Retry
            </Button>
          </>
        )}
      </span>
    </div>
  );
}

/** The label picker (`l`): the Account's labels, each ticked when the thread has it; ticking adds or removes it. */
export function LabelPicker({
  thread,
  labels,
  onToggle,
  onClose,
}: {
  thread: EmailThreadSummary;
  labels: EmailLabel[];
  onToggle: (label: EmailLabel, on: boolean) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const has = new Set((thread.labels ?? []).map((label) => label.id));
  // Ticks shown at once, before the change comes back from the Item store.
  const [ticked, setTicked] = useState<ReadonlyMap<string, boolean>>(new Map());
  const toggle = (label: EmailLabel, on: boolean) => {
    setTicked((now) => new Map(now).set(label.id, on));
    onToggle(label, on);
  };
  const shown = labels.filter((label) => label.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(420px,calc(100vw-48px))]">
        <DialogHeader partNumber="EML-L">
          <DialogTitle>Labels</DialogTitle>
        </DialogHeader>
        <DialogDescription className="sr-only">Gmail labels for {thread.subject}</DialogDescription>
        <DialogBody className="flex flex-col gap-3">
          <Input
            aria-label="Find a label"
            placeholder="Find a label"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {shown.length ? (
            <ul className="m-0 flex max-h-[320px] list-none flex-col overflow-auto p-0">
              {shown.map((label) => (
                <li key={label.id} className="border-b border-line2">
                  <label className="flex cursor-pointer items-center gap-2.5 py-2 text-row text-ink">
                    <input
                      type="checkbox"
                      checked={ticked.get(label.id) ?? has.has(label.id)}
                      onChange={(event) => toggle(label, event.target.checked)}
                    />
                    {label.name}
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-note text-faint">
              {labels.length
                ? 'No label matches.'
                : 'This Account has no labels of its own yet. Make them in Gmail.'}
            </p>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const localInput = (at: number) => {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** The snooze picker (`z`): the quick times, or a picked one; and Unsnooze for a snoozed thread. */
export function SnoozePicker({
  thread,
  now,
  onSnooze,
  onUnsnooze,
  onClose,
}: {
  thread: EmailThreadSummary;
  now: number;
  onSnooze: (until: number) => void;
  onUnsnooze: () => void;
  onClose: () => void;
}) {
  const choices = emailSnoozeChoices(now);
  const [picked, setPicked] = useState(() => localInput((choices[0]?.until ?? now) as number));
  const [error, setError] = useState<string | null>(null);
  const snoozePicked = () => {
    const until = new Date(picked).getTime();
    if (!Number.isFinite(until) || until <= now) {
      setError('Pick a time later than now.');
      return;
    }
    onSnooze(until);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(440px,calc(100vw-48px))]">
        <DialogHeader partNumber="EML-Z">
          <DialogTitle>Snooze until</DialogTitle>
        </DialogHeader>
        <DialogDescription className="sr-only">
          When {thread.subject} comes back to the inbox
        </DialogDescription>
        <DialogBody className="flex flex-col gap-3">
          <ul className="m-0 flex list-none flex-col p-0">
            {choices.map((choice) => (
              <li key={choice.label} className="border-b border-line2">
                <button
                  type="button"
                  onClick={() => onSnooze(choice.until)}
                  className="flex w-full cursor-pointer items-center justify-between gap-3 border-0 bg-transparent px-1 py-2 text-left text-row text-ink hover:bg-raise"
                >
                  {choice.label}
                  <span className="font-mono text-label uppercase tracking-label text-muted">
                    {snoozeTime(choice.until, now)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-end gap-2">
            <label
              htmlFor="snooze-picked"
              className="flex min-w-0 flex-1 flex-col gap-1 font-mono text-label uppercase tracking-label text-muted"
            >
              Date and time
              <Input
                id="snooze-picked"
                type="datetime-local"
                value={picked}
                onChange={(event) => {
                  setPicked(event.target.value);
                  setError(null);
                }}
              />
            </label>
            <Button onClick={snoozePicked}>Snooze</Button>
          </div>
          {error && <p className="m-0 text-note font-semibold text-ink">{error}</p>}
          <p className="m-0 text-note text-muted">{SNOOZE_NOTE}</p>
          {thread.snoozedUntil && (
            <Button variant="ghost" onClick={onUnsnooze}>
              Unsnooze
            </Button>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
