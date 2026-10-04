import type { EmailThread, EmailThreadSummary, Item } from '@commander/domain';
import type { GoogleAccountSummary } from '@commander/domain/ipc';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ItemChanges } from '../../item-store/changes';
import type { EmailAccountsClient, EmailClient } from './email';

export const ACCOUNT_STORAGE_KEY = 'commander.email.account';

// A thread's identity: its Account and thread key.
export const threadId = (thread: { account: string; threadKey: string }) =>
  `${thread.account}\u0000${thread.threadKey}`;

export interface EmailState {
  /** The email Accounts (Google Accounts with Gmail on), each with how it is syncing. */
  accounts: GoogleAccountSummary[];
  /** Whether the Accounts and threads have loaded once. */
  loaded: boolean;
  /** All Accounts ('all'), or one Account's id. Remembered across restarts. */
  account: string;
  setAccount(account: string): void;
  /** Unread threads in the inbox: for all Accounts ('all') and for each, by id. */
  unread: ReadonlyMap<string, number>;
  /** The listed threads (the Account switcher's and the Project filter's), newest first. */
  threads: EmailThreadSummary[];
  /** Every thread of the chosen Account(s), for the Project filter's counts (its latest message). */
  forProjectFilter: Item[];
  /** Inbox threads for the chosen Account(s), whatever the Project filter. */
  total: number;
  /** The selected thread: one that is listed, or one opened from elsewhere (the palette). */
  selected: EmailThreadSummary | null;
  selectedId: string | null;
  select(id: string): void;
  moveSelection(step: 1 | -1): void;
  /** Opens the thread an email is in, wherever it is (an archived one, another Account's). */
  reveal(itemId: string): Promise<void>;
  open: boolean;
  setOpen(open: boolean): void;
  /** The open thread's messages with their bodies, once read. */
  thread: EmailThread | null;
  /** Files the selected thread's messages under a Project (or Unfiled). Returns the change's entries. */
  file(projectId: string | null): Promise<number[]>;
  /** Undoes a change made here (all its entries). */
  undo(entryIds: number[]): Promise<void>;
  /** Asks every email Account to sync now (the sync engine's refresh of its Gmail). */
  refresh(): void;
  reload(): void;
}

function loadAccount(storage: Storage): string {
  try {
    return storage.getItem(ACCOUNT_STORAGE_KEY) ?? 'all';
  } catch {
    return 'all';
  }
}

// What changes when mail arrives: each Account's last sync, and how far a first download has got.
const syncSignature = (accounts: readonly GoogleAccountSummary[]) =>
  accounts
    .map(
      (account) => `${account.id}:${account.sync?.lastSyncedAt ?? ''}:${account.sync?.progress?.done ?? ''}`,
    )
    .join('|');

/**
 * The Email Section's state: the email Accounts, the Account switcher, the inbox's threads (with the
 * Project filter's `include` over each thread's latest message), the selection and the open thread.
 * It reads the threads again when the Accounts' syncing moves on, when Items change, and on `reload`.
 */
export function useEmail({
  client,
  accounts: accountsClient,
  changes,
  include,
  storage = window.localStorage,
}: {
  client: EmailClient;
  accounts: EmailAccountsClient;
  changes: ItemChanges;
  include: (item: Pick<Item, 'filing'>) => boolean;
  storage?: Storage;
}): EmailState {
  const [knownAccounts, setAccounts] = useState<GoogleAccountSummary[] | null>(null);
  const accounts = useMemo(() => knownAccounts ?? [], [knownAccounts]);
  const [chosen, setChosen] = useState(() => loadAccount(storage));
  const account =
    chosen === 'all' || accounts.some((each) => each.id === chosen) || !knownAccounts ? chosen : 'all';
  const [list, setList] = useState<EmailThreadSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [unread, setUnread] = useState<ReadonlyMap<string, number>>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A thread opened from elsewhere that the list doesn't show.
  const [outside, setOutside] = useState<EmailThreadSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [thread, setThread] = useState<EmailThread | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  const refreshWanted = useRef(false);

  useEffect(() => {
    let live = true;
    void accountsClient.list().then((found) => {
      if (live) setAccounts(found);
    });
    const stop = accountsClient.onChange((found) => setAccounts(found));
    return () => {
      live = false;
      stop();
    };
  }, [accountsClient]);

  // Items changed anywhere (filing, a sync finishing): read the threads again.
  useEffect(() => changes(() => reload()), [changes, reload]);

  const signature = syncSignature(accounts);
  const accountIds = accounts.map((each) => each.id).join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` and `version` say when to read again
  useEffect(() => {
    if (!knownAccounts) return;
    let live = true;
    const ids = accountIds ? accountIds.split('|') : [];
    void (async () => {
      const [shown, all, ...each] = await Promise.all([
        client.threads(account === 'all' ? {} : { account }),
        client.threads({ limit: 1 }),
        ...ids.map((id) => client.threads({ account: id, limit: 1 })),
      ]);
      if (!live) return;
      setList(shown.threads);
      setTotal(shown.total);
      setUnread(
        new Map([
          ['all', all.unreadThreads],
          ...ids.map((id, n): [string, number] => [id, each[n]?.unreadThreads ?? 0]),
        ]),
      );
    })();
    return () => {
      live = false;
    };
  }, [client, account, accountIds, signature, version, knownAccounts]);

  const threads = useMemo(() => (list ?? []).filter((each) => include(each.latest)), [list, include]);
  const forProjectFilter = useMemo(() => (list ?? []).map((each) => each.latest), [list]);

  const listedSelection = threads.find((each) => threadId(each) === selectedId) ?? null;
  const selected =
    listedSelection ?? (outside && threadId(outside) === selectedId ? outside : null) ?? threads[0] ?? null;
  const selectedKey = selected ? threadId(selected) : null;

  // The open thread's messages, read again whenever the threads are.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `list` changing means the thread may have too
  useEffect(() => {
    if (!open || !selected) {
      setThread(null);
      return;
    }
    let live = true;
    void client.thread(selected.account, selected.threadKey).then((found) => {
      if (live) setThread(found);
    });
    return () => {
      live = false;
    };
  }, [client, open, selectedKey, list]);

  const setAccount = useCallback(
    (next: string) => {
      setChosen(next);
      setSelectedId(null);
      setOutside(null);
      try {
        storage.setItem(ACCOUNT_STORAGE_KEY, next);
      } catch {
        // Not remembered, then.
      }
    },
    [storage],
  );

  const select = useCallback((id: string) => {
    setSelectedId(id);
    setOutside(null);
  }, []);

  const moveSelection = useCallback(
    (step: 1 | -1) => {
      if (!threads.length) return;
      const at = threads.findIndex((each) => threadId(each) === selectedKey);
      const next = threads[at === -1 ? 0 : Math.min(threads.length - 1, Math.max(0, at + step))];
      if (next) select(threadId(next));
    },
    [threads, selectedKey, select],
  );

  const reveal = useCallback(
    async (itemId: string) => {
      const listed = (list ?? []).find((each) => each.itemIds.includes(itemId));
      if (listed) {
        select(threadId(listed));
        setOpen(true);
        return;
      }
      const item = await client.item(itemId);
      if (item?.detail?.kind !== 'email' || !item.account) return;
      const found = await client.thread(item.account, item.detail.threadKey);
      const latest = found?.messages.at(-1)?.item ?? item;
      const detail = latest.detail?.kind === 'email' ? latest.detail : item.detail;
      const summary: EmailThreadSummary = {
        account: item.account,
        threadKey: item.detail.threadKey,
        subject: detail.subject || latest.title,
        senders: [],
        snippet: detail.snippet,
        latestAt: detail.sentAt,
        messageCount: found?.messages.length ?? 1,
        unreadCount: 0,
        hasAttachments: false,
        latest,
        itemIds: found?.messages.map((message) => message.item.id) ?? [item.id],
      };
      setOutside(summary);
      setSelectedId(threadId(summary));
      setOpen(true);
    },
    [client, list, select],
  );

  const refresh = useCallback(() => {
    if (!knownAccounts) {
      refreshWanted.current = true;
      return;
    }
    for (const each of knownAccounts) void accountsClient.refresh(each.id);
  }, [accountsClient, knownAccounts]);

  // A refresh asked for before the Accounts were read goes once they are.
  useEffect(() => {
    if (knownAccounts && refreshWanted.current) {
      refreshWanted.current = false;
      for (const each of knownAccounts) void accountsClient.refresh(each.id);
    }
  }, [accountsClient, knownAccounts]);

  const file = useCallback(
    async (projectId: string | null) => {
      if (!selected) return [];
      const entries = await client.file(selected.itemIds, projectId);
      reload();
      return entries.map((entry) => entry.id);
    },
    [client, selected, reload],
  );

  const undo = useCallback(
    async (entryIds: number[]) => {
      await client.undo(entryIds);
      reload();
    },
    [client, reload],
  );

  return {
    accounts,
    loaded: knownAccounts !== null && list !== null,
    account,
    setAccount,
    unread,
    threads,
    forProjectFilter,
    total,
    selected,
    selectedId: selectedKey,
    select,
    moveSelection,
    reveal,
    open,
    setOpen,
    thread,
    file,
    undo,
    refresh,
    reload,
  };
}
