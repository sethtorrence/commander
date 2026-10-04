import type { EmailLabel, EmailThreadSummary, ThreadAction } from '@commander/domain';
import type { GoogleAccountSummary } from '@commander/domain/ipc';
import { cn, Kbd, Led, toast } from '@commander/ui';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useReveal } from '../../frame/reveal';
import { useNow } from '../../frame/use-now';
import type { ItemChanges } from '../../item-store/changes';
import { ItemWarning } from '../../links/ItemWarning';
import { BadgePicker, type PickerTarget } from '../../projects/BadgePicker';
import { ItemBadge, SectionProjectFilter, useAccentBar } from '../../projects/badges';
import { useProjectFilter, useProjects } from '../../projects/context';
import { useShortcuts } from '../../shortcuts/react';
import { EmptySheet, SectionSheet, useSection, useTabCount } from '../section';
import {
  GmailSearchLinks,
  LabelPicker,
  SearchBox,
  SnoozePicker,
  ThreadActions,
  ThreadMarks,
  ViewBar,
} from './EmailOrganising';
import { type EmailAccountsClient, type EmailClient, emailSyncLine, threadTime } from './email';
import { actionToast } from './organising';
import { type EmailReaderClient, textOnlyReader } from './reader';
import { ThreadReader } from './ThreadReader';
import { threadId, useEmail } from './use-email';

// Enter opens the selected thread, except on a control that Enter presses (a button, a link).
const onPressable = () => !!document.activeElement?.closest('button, a[href], summary, [role="button"]');

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

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
  onRefresh,
}: {
  accounts: GoogleAccountSummary[];
  account: string;
  unread: ReadonlyMap<string, number>;
  onAccount: (account: string) => void;
  status: { text: string; problem: boolean; syncing: boolean };
  onRefresh: () => void;
}) {
  const choices = [
    { id: 'all', name: 'All Accounts', kind: `${accounts.length} connected` },
    ...accounts.map((each) => ({ id: each.id, name: each.email, kind: 'Gmail' })),
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
      <p
        data-testid="email-sync-status"
        role="status"
        className={cn(
          'm-0 ml-auto flex min-w-0 items-center gap-2 self-center px-4 text-right font-mono text-label leading-tight uppercase tracking-label',
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
  onOpen,
  onFile,
}: {
  thread: EmailThreadSummary;
  number: number;
  selected: boolean;
  /** The Account's address, when threads of several Accounts are listed. */
  account: string | null;
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
          <ItemBadge filing={thread.latest.filing} />
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
}: {
  client: EmailClient;
  accounts: EmailAccountsClient;
  changes: ItemChanges;
  /** The sandboxed HTML reader (the window's bridge); without it every message shows as text. */
  reader?: EmailReaderClient;
}) {
  const { include } = useProjectFilter();
  const { projectOf } = useProjects();
  const now = useNow(60_000);
  const state = useEmail({ client, accounts, changes, include });
  const { selected, open, setOpen } = state;
  const [picking, setPicking] = useState<{ target: PickerTarget; anchor: HTMLElement | null } | null>(null);
  // The label or snooze picker open on a thread (#135), and the Account's labels for the first.
  const [organising, setOrganising] = useState<
    | { kind: 'labels'; thread: EmailThreadSummary; labels: EmailLabel[] }
    | { kind: 'snooze'; thread: EmailThreadSummary }
    | null
  >(null);
  const [typed, setTyped] = useState('');
  const searchBox = useRef<HTMLInputElement>(null);
  const several = state.accounts.length > 1 && state.account === 'all';
  const accountName = useCallback(
    (accountId: string) => state.accounts.find((each) => each.id === accountId)?.email ?? accountId,
    [state.accounts],
  );

  // The inbox's unread threads; no count at all until there is an email Account.
  useTabCount(state.loaded && state.accounts.length > 0 ? (state.unread.get('all') ?? 0) : null);
  useRefreshWhenOpened(state.refresh, state.reload);
  useReveal('email', (itemId) => void state.reveal(itemId));

  const file = (anchor?: HTMLElement | null) => {
    if (!selected) return;
    const badge =
      anchor ??
      document.querySelector<HTMLElement>(
        `[data-item-id="${CSS.escape(selected.latest.id)}"] [data-slot="badge"]`,
      );
    setPicking({
      target: { id: selected.latest.id, title: selected.subject, filing: selected.latest.filing },
      anchor: badge,
    });
  };

  const pick = async (projectId: string | null) => {
    const subject = selected?.subject ?? '';
    setPicking(null);
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
      toast(actionToast(action, thread.subject, Date.now()), {
        action: { label: 'Undo', onClick: () => void state.undo(entries) },
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  };
  const openLabels = async (thread = selected) => {
    if (!thread) return;
    setOrganising({ kind: 'labels', thread, labels: await client.labels(thread.account) });
  };
  const openSnooze = (thread = selected) => {
    if (thread) setOrganising({ kind: 'snooze', thread });
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
    {
      keys: '/',
      label: 'Search mail (from: to: subject: has:attachment is:unread in:)',
      run: () => searchBox.current?.focus(),
    },
    { keys: 'Ctrl+z', label: 'Undo', run: () => void state.undoLast() },
  ]);

  const status = emailSyncLine(state.accounts, now);
  const viewName = state.views.find((each) => each.view === state.view)?.name ?? 'Inbox';
  // Gmail's own search, in the Account the switcher shows (or each).
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
      <AccountBar
        accounts={state.accounts}
        account={state.account}
        unread={state.unread}
        onAccount={state.setAccount}
        status={status}
        onRefresh={state.refresh}
      />
      <ViewBar
        views={state.views}
        view={state.view}
        searching={state.search !== null}
        onView={state.setView}
      />
      <SectionProjectFilter items={state.forProjectFilter} />
      {noAccounts ? (
        <EmptySheet>
          No email Account connected yet. Connect a Google Account in Settings → Accounts (,).
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
            {state.threads.length ? (
              <ul className="m-0 list-none p-0">
                {state.threads.map((thread, index) => (
                  <ThreadRow
                    key={threadId(thread)}
                    thread={thread}
                    number={index + 1}
                    selected={threadId(thread) === state.selectedId}
                    account={several ? accountName(thread.account) : null}
                    onOpen={() => {
                      state.select(threadId(thread));
                      setOpen(true);
                    }}
                    onFile={(anchor) => {
                      state.select(threadId(thread));
                      setPicking({
                        target: { id: thread.latest.id, title: thread.subject, filing: thread.latest.filing },
                        anchor,
                      });
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
                      : `${viewName === 'Inbox' ? 'The inbox' : viewName} is empty.`}
                </p>
              )
            )}
            {state.search !== null && <GmailSearchLinks text={state.search} accounts={searchAccounts} />}
          </div>
          {open && (
            <ThreadReader
              thread={state.thread}
              summary={selected}
              accountName={accountName}
              reader={reader}
              onClose={() => setOpen(false)}
              toolbar={
                selected && (
                  <ThreadActions
                    thread={selected}
                    view={state.view}
                    sync={state.sync}
                    superseded={state.superseded}
                    onAct={(action) => void act(action)}
                    onLabels={() => void openLabels()}
                    onSnooze={() => openSnooze()}
                    onRetry={() => void state.retry()}
                  />
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
