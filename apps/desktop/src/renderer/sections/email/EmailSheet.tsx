import {
  type BucketSortedBy,
  type EmailLabel,
  type EmailThreadSummary,
  type ThreadAction,
  UNSORTED,
} from '@commander/domain';
import { cn, Kbd, Led, SuggestedFiling, toast } from '@commander/ui';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { BucketChip } from '../../buckets/BucketChip';
import { bucketName } from '../../buckets/buckets';
import { SuggestedBucket } from '../../buckets/SuggestedBucket';
import { useReveal } from '../../frame/reveal';
import { useNow } from '../../frame/use-now';
import type { ItemChanges } from '../../item-store/changes';
import { ItemWarning } from '../../links/ItemWarning';
import { BadgePicker, type PickerTarget } from '../../projects/BadgePicker';
import { ItemBadge, SectionProjectFilter, useAccentBar, waitingSuggestion } from '../../projects/badges';
import { useProjectFilter, useProjects } from '../../projects/context';
import { useShortcuts } from '../../shortcuts/react';
import type { AutonomyClient } from '../ares/activity';
import { EmptySheet, SectionSheet, useSection, useTabCount } from '../section';
import { CloudMailQuestions } from './CloudMail';
import { Composer } from './compose/Composer';
import { DraftList, OutboxList, OutboxNote } from './compose/ComposeViews';
import { type ComposeClient, noCompose } from './compose/compose';
import { useCompose } from './compose/use-compose';
import { BucketPicker, BucketStrip } from './EmailBuckets';
import {
  FolderPicker,
  LabelPicker,
  SearchBox,
  SearchLinks,
  SnoozePicker,
  ThreadActions,
  ThreadMarks,
  ViewBar,
} from './EmailOrganising';
import {
  type EmailAccountSummary,
  type EmailAccountsClient,
  type EmailClient,
  emailAddressOf,
  emailSyncLine,
  providerOf,
  threadTime,
} from './email';
import { actionToast } from './organising';
import { type EmailReaderClient, textOnlyReader } from './reader';
import { SuggestedReplyCard } from './SuggestedReply';
import {
  SkipInboxMark,
  SkipInboxOffer,
  SkipInboxSuggestion,
  suggestionsOn,
  useSkipSuggestions,
} from './skip-inbox';
import { ThreadReader } from './ThreadReader';
import { threadId, useEmail } from './use-email';
import { useAresSorting } from './use-sorting';

// Enter opens the selected thread, except on a control that Enter presses (a button, a link).
const onPressable = () => !!document.activeElement?.closest('button, a[href], summary, [role="button"]');

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

// How a thread came to be in its Bucket (#137), as the thread's Bucket button says it.
const SORTED_BY: Record<BucketSortedBy, string> = {
  rule: 'Sorted by a Rule',
  ares: 'Sorted by Ares',
  user: 'Sorted by you',
};

const KEYS: [ReactNode, string][] = [
  [
    <>
      <Kbd>J</Kbd>
      <Kbd>K</Kbd>
    </>,
    'Move',
  ],
  [<Kbd key="enter">↵</Kbd>, 'Open'],
  [<Kbd key="e">E</Kbd>, 'Archive'],
  [<Kbd key="z">Z</Kbd>, 'Snooze'],
  [<Kbd key="v">V</Kbd>, 'Bucket'],
  [
    <>
      <Kbd>C</Kbd>
      <Kbd>R</Kbd>
    </>,
    'Write · Reply',
  ],
  [<Kbd key="d">D</Kbd>, 'Draft (Ares)'],
  [<Kbd key="slash">/</Kbd>, 'Search'],
  [<Kbd key="b">B</Kbd>, 'Project'],
  [<Kbd key="esc">Esc</Kbd>, 'Close'],
];

function Keys() {
  return (
    <div className="grid grid-cols-[auto_auto] gap-x-3.5 gap-y-[5px] pb-0.5 font-mono text-label leading-[19px] font-medium uppercase tracking-label whitespace-nowrap text-muted [&_kbd]:h-[17px] [&_kbd]:min-w-[17px] [&_kbd]:text-label">
      {KEYS.map(([caps, label]) => (
        <span key={label} className="flex items-center gap-[7px]">
          {caps} {label}
        </span>
      ))}
    </div>
  );
}

/**
 * The Account switcher (the prototype's .ebar): All Accounts, then each Account with its unread
 * threads, and the thin sync status line with Refresh on the right.
 */
function AccountBar({
  accounts,
  account,
  unread,
  onAccount,
  status,
  sorting,
  onRefresh,
}: {
  accounts: EmailAccountSummary[];
  account: string;
  unread: ReadonlyMap<string, number>;
  onAccount: (account: string) => void;
  status: { text: string; problem: boolean; syncing: boolean };
  /** "Ares is sorting: 400 of 3,000" while he sorts a download (#141), else null. */
  sorting: string | null;
  onRefresh: () => void;
}) {
  const choices = [
    { id: 'all', name: 'All Accounts', kind: `${accounts.length} connected` },
    ...accounts.map((each) => ({ id: each.id, name: emailAddressOf(each), kind: providerOf(each) })),
  ];
  return (
    <div className="flex h-[46px] flex-none items-stretch border-b border-line">
      <span className="grid w-[41px] flex-none place-items-center border-r border-line2 font-mono text-[8px] leading-none font-semibold tracking-caps text-faint">
        ACCT
      </span>
      <div role="tablist" aria-label="Account" className="flex min-w-0 items-stretch">
        {choices.map((choice) => {
          const on = choice.id === account;
          return (
            <button
              key={choice.id}
              type="button"
              role="tab"
              aria-selected={on}
              aria-label={choice.name}
              onClick={() => onAccount(choice.id)}
              className={cn(
                'flex min-w-0 cursor-pointer flex-col items-start justify-center gap-[5px] border-0 border-r border-line2 px-4 text-left',
                on ? 'bg-ink' : 'bg-transparent hover:bg-raise',
              )}
            >
              <span
                className={cn(
                  'font-sans text-[11.5px] leading-none font-bold uppercase tracking-[.05em] whitespace-nowrap font-stretch-(--stretch-wide)',
                  on ? 'text-sheet' : 'text-ink',
                )}
              >
                {choice.name}
              </span>
              <span
                className={cn(
                  'font-mono text-[8.5px] leading-none font-medium uppercase tracking-caps whitespace-nowrap',
                  on ? 'text-sheet' : 'text-muted',
                )}
              >
                {choice.kind} · <b className={on ? 'text-sheet' : 'text-ink'}>{unread.get(choice.id) ?? 0}</b>{' '}
                unread
              </span>
            </button>
          );
        })}
      </div>
      {sorting && (
        <p
          data-testid="email-sorting-status"
          role="status"
          className="m-0 ml-auto flex min-w-0 flex-none items-center gap-2 self-center pl-4 font-mono text-label leading-tight font-medium uppercase tracking-label text-faint"
        >
          <Led size="sm" />
          <span className="truncate">{sorting}</span>
        </p>
      )}
      <p
        data-testid="email-sync-status"
        role="status"
        className={cn(
          'm-0 flex min-w-0 items-center gap-2 self-center px-4 text-right font-mono text-label leading-tight uppercase tracking-label',
          !sorting && 'ml-auto',
          status.problem ? 'font-semibold text-ink' : 'font-medium text-faint',
        )}
      >
        {status.syncing && <Led size="sm" />}
        <span className="truncate">{status.text}</span>
      </p>
      <button
        type="button"
        onClick={onRefresh}
        disabled={accounts.length === 0}
        className="flex flex-none cursor-pointer items-center border-0 border-l border-line bg-transparent px-4 font-mono text-label leading-none font-semibold uppercase tracking-caps text-ink hover:bg-raise disabled:cursor-default disabled:text-faint"
      >
        Refresh
      </button>
    </div>
  );
}

function PaperclipMark() {
  return (
    <svg
      role="img"
      aria-label="Has attachments"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 flex-none text-muted"
    >
      <title>Has attachments</title>
      <path
        d="M10.5 4.5 5.8 9.2a1.5 1.5 0 0 0 2.1 2.1l5-5a3 3 0 0 0-4.2-4.2l-5.3 5.3a4.5 4.5 0 0 0 6.4 6.4L13 10.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}

/** A thread's row: who wrote, how many messages and when, then its subject and the latest snippet. */
function ThreadRow({
  thread,
  number,
  selected,
  account,
  bucket,
  suggestedBucket,
  onConfirmBucket,
  onChangeBucket,
  suggested = false,
  onOpen,
  onFile,
}: {
  thread: EmailThreadSummary;
  number: number;
  selected: boolean;
  /** Ares suggests archiving it (Skip the inbox, #142). */
  suggested?: boolean;
  /** The Account's address, when threads of several Accounts are listed. */
  account: string | null;
  /** Its Bucket's name, or null while Unsorted (#137). */
  bucket: string | null;
  /** Ares's suggested Bucket's name while it waits (#141), else null. */
  suggestedBucket: string | null;
  onConfirmBucket: () => void;
  onChangeBucket: () => void;
  onOpen: () => void;
  onFile: (anchor: HTMLElement) => void;
}) {
  const row = useRef<HTMLLIElement>(null);
  const now = useNow(60_000);
  const unread = thread.unreadCount > 0;
  const bar = useAccentBar(thread.latest.filing);
  useEffect(() => {
    if (selected) row.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: j/k and Enter work from the keyboard (EmailSheet's shortcuts)
    <li
      ref={row}
      data-testid="email-thread"
      data-unread={unread}
      aria-current={selected || undefined}
      aria-label={`${thread.senders.join(', ')}: ${thread.subject}`}
      onClick={onOpen}
      className={cn(
        'relative cursor-default border-b border-line2 py-2.5 pr-4 pl-13',
        selected
          ? 'bg-signal-focus shadow-[inset_3px_0_0_var(--signal)]'
          : 'hover:bg-[color-mix(in_srgb,var(--raise)_55%,transparent)]',
      )}
    >
      {bar && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-px bottom-0 left-[39px] w-0.5"
          style={{ background: bar }}
        />
      )}
      <span
        className={cn(
          'absolute top-2.5 left-0 w-10 text-center font-mono text-label leading-5',
          selected ? 'font-semibold text-signal-ink' : 'font-medium text-faint',
        )}
      >
        {pad(number, 3)}
      </span>
      <div className="flex items-baseline gap-2.5">
        <button
          type="button"
          data-item-id={thread.latest.id}
          title="Change the Project (B)"
          aria-label={`Project of ${thread.subject}`}
          onClick={(event) => {
            event.stopPropagation();
            onFile(event.currentTarget);
          }}
          className="flex flex-none cursor-pointer self-center border-0 bg-transparent p-0 hover:outline hover:outline-offset-1 hover:outline-ink"
        >
          <ItemBadge filing={thread.latest.filing} suggestion={waitingSuggestion(thread.latest)} />
        </button>
        <span
          data-testid="thread-senders"
          className={cn('min-w-0 truncate text-row leading-5 text-ink', unread ? 'font-bold' : 'font-medium')}
        >
          {thread.senders.join(', ')}
        </span>
        {thread.messageCount > 1 && (
          <span data-testid="thread-count" className="flex-none font-mono text-label text-muted">
            {thread.messageCount}
          </span>
        )}
        <span
          data-testid="thread-time"
          className={cn(
            'ml-auto flex-none font-mono text-label leading-5 tracking-mono',
            unread ? 'font-semibold text-ink' : 'text-muted',
          )}
        >
          {threadTime(thread.latestAt, now)}
        </span>
      </div>
      <div
        data-testid="thread-subject"
        className={cn('truncate text-row leading-5', unread ? 'font-semibold text-ink' : 'text-text')}
      >
        {thread.subject || '(no subject)'}
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-2">
        <ItemWarning item={thread.latest} />
        {bucket === null && suggestedBucket ? (
          <SuggestedBucket name={suggestedBucket} onConfirm={onConfirmBucket} onChange={onChangeBucket} />
        ) : (
          <BucketChip faint={bucket === null}>{bucket ?? 'Unsorted'}</BucketChip>
        )}
        {suggested && <SkipInboxMark />}
        {account && (
          <span className="inline-flex h-5 max-w-[180px] flex-none items-center border border-line bg-sheet px-[7px] font-mono text-label leading-none font-medium uppercase tracking-label whitespace-nowrap text-muted">
            <span className="truncate normal-case">{account}</span>
          </span>
        )}
        {thread.hasAttachments && <PaperclipMark />}
        <ThreadMarks thread={thread} now={now.getTime()} />
        <span className="min-w-0 truncate text-note text-muted">{thread.snippet}</span>
      </div>
    </li>
  );
}

// What the Badge picker files: a thread's latest message (its Project is the thread's), with Ares's
// filing suggestion on it, if one waits (#141).
const pickerTarget = (thread: EmailThreadSummary): PickerTarget => ({
  id: thread.latest.id,
  title: thread.subject,
  filing: thread.latest.filing,
  ...(thread.latest.filingSuggestion && { filingSuggestion: thread.latest.filingSuggestion }),
});

/**
 * Ares's suggestions on the open thread (#141): his suggested Bucket while it is Unsorted, and his
 * dashed Badge while it is Unfiled, each with Confirm and Change.
 */
function ThreadSuggestions({
  thread,
  bucketName,
  onConfirmBucket,
  onChangeBucket,
  onConfirmFiling,
  onChangeFiling,
}: {
  thread: EmailThreadSummary;
  bucketName: (bucketId: string | null | undefined) => string | null;
  onConfirmBucket: () => void;
  onChangeBucket: () => void;
  onConfirmFiling: () => void;
  onChangeFiling: () => void;
}) {
  const { projectById } = useProjects();
  const bucket = thread.bucket ? null : bucketName(thread.latest.bucketSuggestion?.bucketId);
  const filing = waitingSuggestion(thread.latest);
  const project = filing ? projectById(filing.projectId) : undefined;
  if (!bucket && !project) return null;
  return (
    <span className="flex flex-none items-center gap-3 border-r border-line2 px-3">
      {bucket && (
        <SuggestedBucket
          data-testid="suggested-bucket"
          name={bucket}
          onConfirm={onConfirmBucket}
          onChange={onChangeBucket}
        />
      )}
      {project && (
        <SuggestedFiling
          data-testid="suggested-filing"
          code={project.code}
          accent={project.accent}
          project={project.name}
          onConfirm={onConfirmFiling}
          onChange={onChangeFiling}
        />
      )}
    </span>
  );
}

/**
 * The Email Section's sheet, after the prototype's Email Section: the sheet header, the Account
 * switcher with the sync status line, the Project filter, then the inbox as threads and, once one
 * is opened, the thread. Opening the Section asks every email Account to sync.
 */
export function EmailSheet({
  client,
  accounts,
  changes,
  reader = textOnlyReader,
  compose = noCompose,
  onSaveBeforeQuit,
  autonomy,
  onAresActivity,
}: {
  client: EmailClient;
  accounts: EmailAccountsClient;
  changes: ItemChanges;
  /** The sandboxed HTML reader (the window's bridge); without it every message shows as text. */
  reader?: EmailReaderClient;
  /** Writing email (#138): the composer, drafts and the Outbox (the window's bridge). */
  compose?: ComposeClient;
  /** Saves the composer's draft when Commander quits (the window's bridge). */
  onSaveBeforeQuit?: (save: () => Promise<void>) => () => void;
  /** The gate (the window's bridge), for Ares's Skip the inbox suggestions (#142); none without it. */
  autonomy?: AutonomyClient;
  /** Hears whenever Ares did or suggested something. */
  onAresActivity?: (listener: () => void) => () => void;
}) {
  const { include } = useProjectFilter();
  const { projectOf, projectById, settleFiling } = useProjects();
  const now = useNow(60_000);
  const state = useEmail({ client, accounts, changes, include });
  // Ares's sorting (#141): his progress, and the Gmail Accounts waiting for the User's answer.
  const sorting = useAresSorting({ client, accounts: state.accounts, changes });
  const { selected, open, setOpen } = state;
  // Skip the inbox (#142): Ares's suggestions to archive, on their emails and grouped by Bucket.
  const skips = useSkipSuggestions(autonomy, changes, onAresActivity, state.reload);
  const skipBucket = state.buckets.find((each) => each.id === state.bucket) ?? null;
  const offered = skipBucket
    ? state.threads.filter(
        (thread) =>
          thread.bucket?.bucketId === skipBucket.id && suggestionsOn(skips.byItem, thread.itemIds).length > 0,
      )
    : [];
  const selectedSkips = selected ? suggestionsOn(skips.byItem, selected.itemIds) : [];
  const [picking, setPicking] = useState<{ target: PickerTarget; anchor: HTMLElement | null } | null>(null);
  // The label or snooze picker open on a thread (#135), and the Account's labels for the first.
  const [organising, setOrganising] = useState<
    | { kind: 'labels' | 'folders'; thread: EmailThreadSummary; labels: EmailLabel[] }
    | { kind: 'snooze'; thread: EmailThreadSummary }
    | { kind: 'bucket'; thread: EmailThreadSummary }
    | null
  >(null);
  const [typed, setTyped] = useState('');
  const searchBox = useRef<HTMLInputElement>(null);
  // Writing email (#138): the composer, the Undo toast, and the Drafts and Outbox views.
  const writing = useCompose({ client: compose, changes });
  const [special, setSpecial] = useState<'drafts' | 'outbox' | null>(null);
  // A reply is written below its thread's messages while that thread is open; elsewhere as a sheet.
  const replyTo = writing.composer?.state.replyToItemId ?? null;
  const inline =
    writing.composer?.placement === 'inline' && open && !!replyTo && !!selected?.itemIds.includes(replyTo);
  // Replying opens the thread, with the composer below its messages.
  const write = (mode: 'reply' | 'reply-all' | 'forward') => {
    if (!selected) return;
    setSpecial(null);
    setOpen(true);
    void writing.open(mode, selected.latest.id);
  };
  // Ares's drafts (#143): the threads he is drafting a reply for now, asked for here.
  const [drafting, setDrafting] = useState<ReadonlySet<string>>(new Set());
  const draftFor = async (thread: EmailThreadSummary | null, instruction?: string) => {
    if (!thread) return;
    const id = threadId(thread);
    setDrafting((now) => new Set([...now, id]));
    try {
      await client.draftReply(thread.latest.id, instruction);
      state.reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setDrafting((now) => new Set([...now].filter((each) => each !== id)));
    }
  };
  // Draft a reply (`d`, and the thread's Draft button): the thread opens with his draft at its end.
  const draftSelected = () => {
    if (!selected) return;
    setSpecial(null);
    setOpen(true);
    void draftFor(selected);
  };
  // Open in composer: his draft becomes an ordinary draft, in the composer below the thread.
  const openSuggested = async () => {
    const suggestion = state.thread?.suggestedReply;
    if (suggestion?.state !== 'ready') return;
    setSpecial(null);
    setOpen(true);
    await writing.openSuggested(suggestion.answering);
    state.reload();
  };
  const dismissSuggested = async () => {
    const suggestion = state.thread?.suggestedReply;
    if (!suggestion) return;
    try {
      await client.dismissSuggestedReply(suggestion.answering);
      state.reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  };
  const several = state.accounts.length > 1 && state.account === 'all';
  const accountName = useCallback(
    (accountId: string) => {
      const found = state.accounts.find((each) => each.id === accountId);
      return found ? emailAddressOf(found) : accountId;
    },
    [state.accounts],
  );
  // Whose mail a thread is (#136): Outlook files in folders and flags; Gmail labels and stars.
  const providerFor = useCallback(
    (thread: EmailThreadSummary | null) =>
      providerOf(state.accounts.find((each) => each.id === thread?.account)),
    [state.accounts],
  );

  // Unread threads in Needs reply (#137); no count at all until there is an email Account.
  useTabCount(state.loaded && state.accounts.length > 0 ? state.needsReply : null);
  const nameOf = useCallback(
    (bucketId: string | null | undefined) => (bucketId ? bucketName(state.buckets, bucketId) : null),
    [state.buckets],
  );
  useRefreshWhenOpened(state.refresh, state.reload);
  useReveal('email', (itemId, focus) => {
    // "12 emails I wasn't sure about" (#141) opens the Unsorted view, where they come first.
    if (!itemId && focus === UNSORTED) {
      state.setView('inbox');
      state.setBucket(UNSORTED);
      return;
    }
    void state.reveal(itemId);
  });

  const file = (anchor?: HTMLElement | null) => {
    if (!selected) return;
    const badge =
      anchor ??
      document.querySelector<HTMLElement>(
        `[data-item-id="${CSS.escape(selected.latest.id)}"] [data-slot="badge"]`,
      );
    setPicking({ target: pickerTarget(selected), anchor: badge });
  };

  const pick = async (projectId: string | null) => {
    const subject = selected?.subject ?? '';
    const suggestion = picking ? waitingSuggestion(picking.target) : undefined;
    setPicking(null);
    // Unfiled, on Ares's dashed Badge: his suggestion turned down (#71, #141).
    if (suggestion && projectId === null) {
      try {
        await settleFiling(suggestion.proposalId, null);
        toast(`Left Unfiled: ${subject}. Ares won’t suggest it again`);
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const entries = await state.file(projectId);
    if (!entries.length) return;
    const project = projectOf(projectId ? { projectId, filedBy: 'user' } : null);
    toast(project ? `Filed under ${project.code}: ${subject}` : `Unfiled: ${subject}`, {
      action: { label: 'Undo', onClick: () => void state.undo(entries) },
    });
  };

  // Organising (#135): every action is one change, shown at once, with Undo in its toast and on Ctrl+Z.
  const act = async (action: ThreadAction, thread = selected) => {
    if (!thread) return;
    try {
      const entries = await state.act(action, thread);
      if (!entries.length) return;
      // Into a Bucket that skips the inbox (#142): archived too, in the same change.
      const skipping =
        action.type === 'bucket' &&
        state.buckets.some((each) => each.id === action.bucketId && each.skipInbox);
      const said = actionToast(
        action,
        thread.subject,
        Date.now(),
        (bucketId) => nameOf(bucketId) ?? 'Unsorted',
        providerFor(thread),
      );
      toast(skipping ? `${said} (archived: it skips the inbox)` : said, {
        action: { label: 'Undo', onClick: () => void state.undo(entries) },
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  };
  const openLabels = async (thread = selected) => {
    if (!thread) return;
    const kind = providerFor(thread) === 'Outlook' ? 'folders' : 'labels';
    setOrganising({ kind, thread, labels: await client.labels(thread.account) });
  };
  const openSnooze = (thread = selected) => {
    if (thread) setOrganising({ kind: 'snooze', thread });
  };
  const openBuckets = (thread = selected) => {
    if (thread) setOrganising({ kind: 'bucket', thread });
  };
  // Confirm on Ares's suggested Bucket (#141): sorted there, by the User, with Undo.
  const confirmBucket = async (thread: EmailThreadSummary) => {
    const suggestion = thread.bucket ? undefined : thread.latest.bucketSuggestion;
    if (!suggestion) return;
    try {
      const entries = await client.confirmBucket(suggestion.proposalId);
      state.reload();
      toast(`Moved to ${nameOf(suggestion.bucketId) ?? 'a Bucket'}: ${thread.subject || '(no subject)'}`, {
        action: { label: 'Undo', onClick: () => void state.undo(entries) },
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  };
  // Confirm on Ares's dashed Badge in the open thread (#141): filed there, by the User.
  const confirmFiling = async (thread: EmailThreadSummary) => {
    const suggestion = waitingSuggestion(thread.latest);
    if (!suggestion) return;
    try {
      const entry = await settleFiling(suggestion.proposalId, suggestion.projectId);
      state.reload();
      const project = projectById(suggestion.projectId);
      if (entry && project)
        toast(`Confirmed under ${project.code}: ${thread.subject || '(no subject)'}`, {
          action: { label: 'Undo', onClick: () => void state.undo([entry.id]) },
        });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  };
  // The thread the picker is on, as it now is (its labels change while the picker is open).
  const organised = organising
    ? (state.threads.find((each) => threadId(each) === threadId(organising.thread)) ?? organising.thread)
    : null;
  const archiveOrRestore = () => {
    if (!selected) return;
    const back = state.view === 'trash' || state.view === 'archive' || selected.inTrash;
    void act({ type: back ? 'move-to-inbox' : 'archive' });
  };
  const search = (text: string) => {
    state.setSearch(text);
    setTyped(text);
  };
  const leaveSearch = () => {
    state.setSearch(null);
    setTyped('');
  };

  useShortcuts([
    { keys: 'j', label: 'Next thread', run: () => state.moveSelection(1) },
    { keys: 'k', label: 'Previous thread', run: () => state.moveSelection(-1) },
    {
      keys: 'Enter',
      label: 'Open the thread',
      when: () => !onPressable() && !!selected,
      run: () => setOpen(true),
    },
    { keys: 'Escape', label: 'Close the thread', when: () => open, run: () => setOpen(false) },
    { keys: 'b', label: 'File the thread under a Project', run: () => file() },
    {
      keys: 'e',
      label: 'Archive (or move back to the inbox)',
      when: () => !!selected,
      run: archiveOrRestore,
    },
    { keys: '#', label: 'Move to Trash', when: () => !!selected, run: () => void act({ type: 'trash' }) },
    {
      keys: 's',
      label: 'Star or unstar',
      when: () => !!selected,
      run: () => void act({ type: selected?.starred ? 'unstar' : 'star' }),
    },
    { keys: 'Shift+I', label: 'Mark read', when: () => !!selected, run: () => void act({ type: 'read' }) },
    {
      keys: 'Shift+U',
      label: 'Mark unread',
      when: () => !!selected,
      run: () => void act({ type: 'unread' }),
    },
    { keys: 'l', label: 'Labels', when: () => !!selected, run: () => void openLabels() },
    { keys: 'z', label: 'Snooze', when: () => !!selected, run: () => openSnooze() },
    { keys: 'v', label: 'Move to a Bucket', when: () => !!selected, run: () => openBuckets() },
    {
      keys: '/',
      label: 'Search mail (from: to: subject: has:attachment is:unread in:)',
      run: () => searchBox.current?.focus(),
    },
    { keys: 'Ctrl+z', label: 'Undo', run: () => void state.undoLast() },
    { keys: 'c', label: 'New message', run: () => void writing.open('new') },
    { keys: 'r', label: 'Reply', when: () => !!selected, run: () => write('reply') },
    { keys: 'Shift+R', label: 'Reply all', when: () => !!selected, run: () => write('reply-all') },
    { keys: 'f', label: 'Forward', when: () => !!selected, run: () => write('forward') },
    { keys: 'd', label: 'Draft a reply (Ares)', when: () => !!selected, run: draftSelected },
  ]);

  const status = emailSyncLine(state.accounts, now);
  const viewName = state.views.find((each) => each.view === state.view)?.name ?? 'Inbox';
  // Gmail's or Outlook's own search, in the Account the switcher shows (or each).
  const searchAccounts =
    state.account === 'all' ? state.accounts : state.accounts.filter((each) => each.id === state.account);
  const unread = state.unread.get(state.account) ?? 0;
  const noAccounts = state.loaded && state.accounts.length === 0;

  return (
    <SectionSheet
      span="full"
      subtitle={
        <>
          <b>{unread} unread</b> in the inbox
          {state.accounts.length > 0 &&
            ` · ${state.account === 'all' ? `${state.accounts.length} ${state.accounts.length === 1 ? 'Account' : 'Accounts'}` : accountName(state.account)}`}
        </>
      }
      aside={<Keys />}
      className="flex flex-col"
    >
      <BucketStrip
        buckets={state.buckets}
        counts={state.bucketCounts}
        bucket={state.bucket}
        onBucket={state.setBucket}
      />
      <AccountBar
        accounts={state.accounts}
        account={state.account}
        unread={state.unread}
        onAccount={state.setAccount}
        status={status}
        sorting={sorting.line}
        onRefresh={state.refresh}
      />
      <CloudMailQuestions
        accounts={sorting.unanswered}
        onAnswer={(account, answer) => void sorting.answer(account, answer)}
      />
      <ViewBar
        views={state.views}
        view={state.view}
        searching={state.search !== null || special !== null}
        onView={(view) => {
          setSpecial(null);
          state.setView(view);
        }}
        extra={(
          [
            ['drafts', 'Drafts', writing.drafts.length],
            ['outbox', 'Outbox', writing.outbox.length],
          ] as const
        ).map(([view, name, count]) => (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={special === view}
            data-view={view}
            onClick={() => {
              setSpecial(view);
              setOpen(false);
            }}
            className={cn(
              'flex flex-none cursor-pointer items-center gap-2 border-0 border-r border-line2 px-3.5 font-mono text-label leading-none font-semibold uppercase tracking-caps whitespace-nowrap',
              special === view ? 'bg-ink text-sheet' : 'bg-transparent text-ink hover:bg-raise',
            )}
          >
            {name}
            {count > 0 && <b className={special === view ? 'text-sheet' : 'text-muted'}>{count}</b>}
          </button>
        ))}
      />
      <SectionProjectFilter items={state.forProjectFilter} />
      {skipBucket && offered.length > 0 && (
        <SkipInboxOffer
          bucket={skipBucket.name}
          threads={offered.length}
          proposalIds={offered.flatMap((thread) =>
            suggestionsOn(skips.byItem, thread.itemIds).map((each) => each.id),
          )}
          suggestions={skips}
        />
      )}
      {noAccounts ? (
        <EmptySheet>
          No email Account connected yet. Connect a Google or Outlook Account in Settings → Accounts (,).
        </EmptySheet>
      ) : (
        <div className={cn('flex-1', open && 'grid grid-cols-[minmax(0,3fr)_minmax(0,5fr)]')}>
          <div className="min-w-0 pb-30">
            <div className="sticky top-0 z-[2] flex h-[30px] items-center justify-between gap-3 border-b border-line bg-sheet pr-3.5 pl-13 font-mono text-label leading-none font-semibold uppercase tracking-caps text-ink">
              <span className="flex-none">
                {state.search !== null ? 'Search' : viewName} · {pad(state.threads.length)}
              </span>
              <SearchBox
                ref={searchBox}
                value={typed}
                onChange={setTyped}
                onSearch={search}
                onLeave={leaveSearch}
              />
            </div>
            {special === 'drafts' ? (
              <DraftList
                drafts={writing.drafts}
                accountName={(id) => (several ? accountName(id) : null)}
                onOpen={(itemId) => void writing.openDraft(itemId)}
                onDiscard={(itemId) => void writing.discard(itemId)}
              />
            ) : special === 'outbox' ? (
              <OutboxList
                outbox={writing.outbox}
                onUndo={(itemId) => void writing.undo(itemId)}
                onRetry={(itemId) => void writing.retry(itemId)}
              />
            ) : state.threads.length ? (
              <ul className="m-0 list-none p-0">
                {state.threads.map((thread, index) => (
                  <ThreadRow
                    key={threadId(thread)}
                    thread={thread}
                    number={index + 1}
                    selected={threadId(thread) === state.selectedId}
                    account={several ? accountName(thread.account) : null}
                    bucket={nameOf(thread.bucket?.bucketId)}
                    suggestedBucket={thread.bucket ? null : nameOf(thread.latest.bucketSuggestion?.bucketId)}
                    onConfirmBucket={() => void confirmBucket(thread)}
                    onChangeBucket={() => {
                      state.select(threadId(thread));
                      openBuckets(thread);
                    }}
                    suggested={suggestionsOn(skips.byItem, thread.itemIds).length > 0}
                    onOpen={() => {
                      state.select(threadId(thread));
                      setOpen(true);
                    }}
                    onFile={(anchor) => {
                      state.select(threadId(thread));
                      setPicking({ target: pickerTarget(thread), anchor });
                    }}
                  />
                ))}
              </ul>
            ) : (
              state.loaded && (
                <p className="hatch m-0 border-b border-line2 py-2.5 pr-5 pl-13 text-note text-faint">
                  {state.search !== null
                    ? 'No mail Commander holds matches.'
                    : state.total
                      ? 'No threads in this Project.'
                      : state.bucket
                        ? `No threads in ${nameOf(state.bucket) ?? 'Unsorted'}.`
                        : `${viewName === 'Inbox' ? 'The inbox' : viewName} is empty.`}
                </p>
              )
            )}
            {state.search !== null && <SearchLinks text={state.search} accounts={searchAccounts} />}
          </div>
          {open && (
            <ThreadReader
              thread={state.thread}
              summary={selected}
              accountName={accountName}
              reader={reader}
              onClose={() => setOpen(false)}
              noteFor={(item) => {
                const entry = writing.outbox.find((each) => each.itemId === item.id);
                return entry ? (
                  <OutboxNote
                    entry={entry}
                    className="mt-3 border-t border-line2 pt-2"
                    onUndo={() => void writing.undo(entry.itemId)}
                    onRetry={() => void writing.retry(entry.itemId)}
                  />
                ) : null;
              }}
              footer={
                inline && writing.composer ? (
                  <Composer
                    key={writing.composer.state.itemId ?? writing.composer.state.replyToItemId ?? 'reply'}
                    client={compose}
                    initial={writing.current() ?? writing.composer.state}
                    accounts={state.accounts}
                    placement="inline"
                    onClose={writing.close}
                    onSent={writing.sent}
                    onState={writing.track}
                    {...(onSaveBeforeQuit ? { onSaveBeforeQuit } : {})}
                  />
                ) : (
                  <SuggestedReplyCard
                    key={selected ? threadId(selected) : 'none'}
                    suggestion={state.thread?.suggestedReply ?? null}
                    drafting={!!selected && drafting.has(threadId(selected))}
                    sources={(state.thread?.messages ?? []).flatMap(({ body }) => (body ? [body.text] : []))}
                    onDraft={(instruction) => void draftFor(selected, instruction)}
                    onOpen={() => void openSuggested()}
                    onDismiss={() => void dismissSuggested()}
                  />
                )
              }
              notice={
                selectedSkips.length > 0 && <SkipInboxSuggestion found={selectedSkips} suggestions={skips} />
              }
              toolbar={
                selected && (
                  <>
                    <ThreadActions
                      thread={selected}
                      view={state.view}
                      sync={state.sync}
                      superseded={state.superseded}
                      provider={providerFor(selected)}
                      onAct={(action) => void act(action)}
                      onLabels={() => void openLabels()}
                      onSnooze={() => openSnooze()}
                      onRetry={() => void state.retry()}
                      bucket={{
                        name: nameOf(selected.bucket?.bucketId) ?? 'Unsorted',
                        how: selected.bucket ? SORTED_BY[selected.bucket.sortedBy] : null,
                      }}
                      onBucket={() => openBuckets()}
                    />
                    <button
                      type="button"
                      title="Draft a reply in your style (D): you edit and send it"
                      onClick={draftSelected}
                      disabled={drafting.has(threadId(selected))}
                      className="flex flex-none cursor-pointer items-center border-0 border-r border-line2 bg-transparent px-3.5 font-mono text-label leading-none font-semibold uppercase tracking-caps whitespace-nowrap text-ink hover:bg-raise disabled:cursor-default disabled:text-faint"
                    >
                      Draft a reply
                    </button>
                    <ThreadSuggestions
                      thread={selected}
                      bucketName={nameOf}
                      onConfirmBucket={() => void confirmBucket(selected)}
                      onChangeBucket={() => openBuckets(selected)}
                      onConfirmFiling={() => void confirmFiling(selected)}
                      onChangeFiling={() => file()}
                    />
                  </>
                )
              }
            />
          )}
        </div>
      )}
      {organising?.kind === 'labels' && organised && (
        <LabelPicker
          thread={organised}
          labels={organising.labels}
          onToggle={(label, on) =>
            void act(on ? { type: 'label', label } : { type: 'unlabel', labelId: label.id }, organised)
          }
          onClose={() => setOrganising(null)}
        />
      )}
      {organising?.kind === 'folders' && organised && (
        <FolderPicker
          thread={organised}
          folders={organising.labels}
          onPick={(folder) => {
            setOrganising(null);
            void act({ type: 'move', folder }, organised);
          }}
          onClose={() => setOrganising(null)}
        />
      )}
      {organising?.kind === 'snooze' && organised && (
        <SnoozePicker
          thread={organised}
          now={Date.now()}
          onSnooze={(until) => {
            setOrganising(null);
            void act({ type: 'snooze', until }, organised);
          }}
          onUnsnooze={() => {
            setOrganising(null);
            void act({ type: 'unsnooze' }, organised);
          }}
          onClose={() => setOrganising(null)}
        />
      )}
      {organising?.kind === 'bucket' && organised && (
        <BucketPicker
          thread={organised}
          buckets={state.buckets}
          onPick={(bucketId) => {
            setOrganising(null);
            void act({ type: 'bucket', bucketId }, organised);
          }}
          onClose={() => setOrganising(null)}
        />
      )}
      {writing.composer && !inline && (
        <Composer
          key={writing.composer.state.itemId ?? writing.composer.state.replyToItemId ?? 'new'}
          client={compose}
          initial={writing.current() ?? writing.composer.state}
          accounts={state.accounts}
          placement="sheet"
          onClose={writing.close}
          onSent={writing.sent}
          onState={writing.track}
          {...(onSaveBeforeQuit ? { onSaveBeforeQuit } : {})}
        />
      )}
      {picking && (
        <BadgePicker
          target={picking.target}
          anchor={picking.anchor}
          onClose={() => setPicking(null)}
          onPick={(projectId) => void pick(projectId)}
        />
      )}
    </SectionSheet>
  );
}

// Opening the Section asks every email Account to sync (the sync engine's refresh); the threads are
// read again whenever it comes into view or the window regains focus.
function useRefreshWhenOpened(refresh: () => void, reload: () => void) {
  const { active } = useSection();
  const wasActive = useRef(false);
  useEffect(() => {
    if (active && !wasActive.current) {
      refresh();
      reload();
    }
    wasActive.current = active;
  }, [active, refresh, reload]);
  const onFocus = useCallback(() => reload(), [reload]);
  useEffect(() => {
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [onFocus]);
}
