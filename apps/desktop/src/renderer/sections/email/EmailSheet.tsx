import {
  addressName,
  type EmailAddress,
  type EmailDetail,
  type EmailThread,
  type EmailThreadSummary,
} from '@commander/domain';
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
import { type EmailAccountsClient, type EmailClient, emailSyncLine, sentTime, threadTime } from './email';
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
        <span className="min-w-0 truncate text-note text-muted">{thread.snippet}</span>
      </div>
    </li>
  );
}

const fullAddress = (address: EmailAddress) =>
  address.name?.trim() ? `${address.name.trim()} <${address.address}>` : address.address;
const addresses = (list: EmailAddress[]) => list.map(fullAddress).join(', ');

function HeaderRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2.5 border-b border-line2 py-1.5 font-mono text-label leading-[1.4] tracking-label">
      <dt className="uppercase text-muted">{label}</dt>
      <dd className="m-0 font-semibold break-words text-ink">{children}</dd>
    </div>
  );
}

/**
 * The open thread (the prototype's reader): its subject, then each message with its headers and its
 * plain-text body. Bodies are only ever shown as text, never as HTML (ADR 0004): an HTML-only message
 * shows its text conversion until the sandboxed reader (#134) arrives.
 */
function ThreadReader({
  thread,
  summary,
  accountName,
  onClose,
}: {
  thread: EmailThread | null;
  summary: EmailThreadSummary | null;
  accountName: (accountId: string) => string;
  onClose: () => void;
}) {
  const subject = summary?.subject || thread?.messages.at(-1)?.item.title || '';
  return (
    <section aria-label="Thread" className="min-w-0 border-l border-line">
      <div className="sticky top-0 z-[2] flex h-11 items-stretch border-b border-line bg-sheet">
        <button
          type="button"
          onClick={onClose}
          className="flex cursor-pointer items-center gap-2 border-0 border-r border-line2 bg-transparent px-3.5 font-mono text-label leading-none font-semibold uppercase tracking-caps text-ink hover:bg-raise"
        >
          <Kbd>Esc</Kbd> Close
        </button>
        {summary && (
          <span className="ml-auto flex items-center px-4 font-mono text-label leading-none uppercase tracking-caps text-faint">
            {summary.messageCount} {summary.messageCount === 1 ? 'message' : 'messages'} ·{' '}
            {accountName(summary.account)}
          </span>
        )}
      </div>
      <div className="max-w-[820px] px-10 pt-5 pb-30">
        <h2 className="m-0 font-sans text-[26px] leading-[1.15] font-bold tracking-[-.015em] text-ink font-stretch-(--stretch-wide)">
          {subject || '(no subject)'}
        </h2>
        {!thread ? (
          <p className="mt-4 text-note text-faint">Reading the thread…</p>
        ) : (
          thread.messages.map(({ item, body }) => {
            const detail = item.detail as EmailDetail;
            return (
              <article key={item.id} data-testid="email-message" className="mt-6 border-t border-line pt-1">
                <ItemWarning item={item} variant="pane" className="mt-2" />
                <dl className="m-0">
                  <HeaderRow label="From">
                    {detail.from ? fullAddress(detail.from) : '(unknown sender)'}
                  </HeaderRow>
                  {detail.to.length > 0 && <HeaderRow label="To">{addresses(detail.to)}</HeaderRow>}
                  {detail.cc.length > 0 && <HeaderRow label="Cc">{addresses(detail.cc)}</HeaderRow>}
                  <HeaderRow label="Date">{sentTime(detail.sentAt)}</HeaderRow>
                  {detail.attachments.some((each) => !each.inline) && (
                    <HeaderRow label="Files">
                      {detail.attachments
                        .filter((each) => !each.inline)
                        .map((each) => each.name)
                        .join(', ')}
                    </HeaderRow>
                  )}
                </dl>
                <div
                  data-testid="email-body"
                  className="mt-4 text-[15px] leading-[1.6] break-words whitespace-pre-wrap text-text"
                >
                  {body ? body.text : ''}
                </div>
                {!body && <p className="mt-2 text-note text-faint">No text was kept for this message.</p>}
                {body?.truncated && (
                  <p className="mt-2 text-note text-faint">This message is long: the rest is in Gmail.</p>
                )}
                {body?.textFromHtml && (
                  <p className="mt-2 font-mono text-label uppercase tracking-label text-faint">
                    Shown as text · {addressName(detail.from)} sent HTML
                  </p>
                )}
              </article>
            );
          })
        )}
      </div>
    </section>
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
}: {
  client: EmailClient;
  accounts: EmailAccountsClient;
  changes: ItemChanges;
}) {
  const { include } = useProjectFilter();
  const { projectOf } = useProjects();
  const now = useNow(60_000);
  const state = useEmail({ client, accounts, changes, include });
  const { selected, open, setOpen } = state;
  const [picking, setPicking] = useState<{ target: PickerTarget; anchor: HTMLElement | null } | null>(null);
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
  ]);

  const status = emailSyncLine(state.accounts, now);
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
      <SectionProjectFilter items={state.forProjectFilter} />
      {noAccounts ? (
        <EmptySheet>
          No email Account connected yet. Connect a Google Account in Settings → Accounts (,).
        </EmptySheet>
      ) : (
        <div className={cn('flex-1', open && 'grid grid-cols-[minmax(0,3fr)_minmax(0,5fr)]')}>
          <div className="min-w-0 pb-30">
            <div className="sticky top-0 z-[2] flex h-[30px] items-center justify-between border-b border-line bg-sheet pr-3.5 pl-13 font-mono text-label leading-none font-semibold uppercase tracking-caps text-ink">
              <span>Inbox · {pad(state.threads.length)}</span>
              <span className="font-medium text-faint">Newest first · J K</span>
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
                  {state.total ? 'No threads in this Project.' : 'The inbox is empty.'}
                </p>
              )
            )}
          </div>
          {open && (
            <ThreadReader
              thread={state.thread}
              summary={selected}
              accountName={accountName}
              onClose={() => setOpen(false)}
            />
          )}
        </div>
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
