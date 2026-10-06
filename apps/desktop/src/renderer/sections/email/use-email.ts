import {
  type Bucket,
  type EmailDetail,
  type EmailListView,
  type EmailThread,
  type EmailThreadFacet,
  type EmailThreadSummary,
  type EmailViewCount,
  type Item,
  inBucket,
  NEEDS_REPLY,
  type OutgoingChange,
  type ThreadAction,
  threadActionFields,
  UNSORTED,
} from '@commander/domain';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ItemChanges } from '../../item-store/changes';
import { type IssueSync, supersededNote } from '../linear/editing';
import { type EmailAccountSummary, type EmailAccountsClient, type EmailClient, mailSourceOf } from './email';
import { loadMarkRead, markReadDelay, threadSync } from './organising';

export const ACCOUNT_STORAGE_KEY = 'commander.email.account';

// A thread's identity: its Account and thread key.
export const threadId = (thread: { account: string; threadKey: string }) =>
  `${thread.account}\u0000${thread.threadKey}`;

/** The view's threads counted by Bucket and Project, from thread summaries (search results). */
export function facetsOf(threads: readonly EmailThreadSummary[]): EmailThreadFacet[] {
  const found = new Map<string, EmailThreadFacet>();
  for (const thread of threads) {
    const bucketId = thread.bucket?.bucketId ?? null;
    const projectId = thread.latest.filing?.projectId ?? null;
    const key = `${bucketId ?? ''}\u0000${projectId ?? ''}`;
    const facet = found.get(key) ?? { bucketId, projectId, threads: 0, unread: 0 };
    facet.threads += 1;
    if (thread.unreadCount > 0) facet.unread += 1;
    found.set(key, facet);
  }
  return [...found.values()];
}

export interface EmailState {
  /** The email Accounts (Google Accounts with Gmail on, Outlook Accounts with mail on), each syncing. */
  accounts: EmailAccountSummary[];
  /** Whether the Accounts and threads have loaded once. */
  loaded: boolean;
  /** All Accounts ('all'), or one Account's id. Remembered across restarts. */
  account: string;
  setAccount(account: string): void;
  /** Unread threads in the inbox: for all Accounts ('all') and for each, by id. */
  unread: ReadonlyMap<string, number>;
  /** Unread inbox threads in Needs reply, every Account's (#137): the Email tab's count. */
  needsReply: number;
  /** The User's Buckets, in their order (#137). */
  buckets: Bucket[];
  /** The Bucket strip's choice: a Bucket's id, Unsorted (`unsorted`), or null for all. */
  bucket: string | null;
  setBucket(bucket: string | null): void;
  /**
   * The listed view's threads by Bucket (a Bucket's id, `unsorted`, and `all`), under the Project
   * filter: the Bucket strip's counts.
   */
  bucketCounts: ReadonlyMap<string, number>;
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
  /** Asks every email Account to sync now (the sync engine's refresh of its Gmail or Outlook). */
  refresh(): void;
  reload(): void;
  /** The view listed (Inbox, Starred, Snoozed, Archive, Trash or a label), and each view's counts. */
  view: EmailListView;
  setView(view: EmailListView): void;
  views: EmailViewCount[];
  /** The search shown instead of the view (null when not searching), as typed with its operators. */
  search: string | null;
  setSearch(text: string | null): void;
  /**
   * Does an action to a thread (the selected one unless given), as one change; resolves with its
   * entries (none when it changed nothing), and keeps it for `undoLast`.
   */
  act(action: ThreadAction, thread?: EmailThreadSummary): Promise<number[]>;
  /** Undoes the last change made here (an action or a filing). */
  undoLast(): Promise<void>;
  /** Whether the selected thread's changes reached Gmail or Outlook, are on their way, or couldn't sync. */
  sync: IssueSync;
  /** Sends the selected thread's changes that couldn't sync again. */
  retry(): Promise<void>;
  /** The note when a change made in Gmail or Outlook won over the User's ("Changed in Gmail at 14:02"), or null. */
  superseded: string | null;
}

function loadAccount(storage: Storage): string {
  try {
    return storage.getItem(ACCOUNT_STORAGE_KEY) ?? 'all';
  } catch {
    return 'all';
  }
}

// What changes when mail arrives: each Account's last sync, and how far a first download has got.
// And changes on their way to Gmail or Outlook, or that couldn't sync (which change no Item).
const syncSignature = (accounts: readonly EmailAccountSummary[]) =>
  accounts
    .map((account) => {
      const mail =
        account.sources.find((each) => each.source === mailSourceOf(account))?.sync ?? account.sync;
      const outgoing = `${mail?.outgoing?.pending ?? 0}/${mail?.outgoing?.failed ?? 0}`;
      return `${account.id}:${mail?.lastSyncedAt ?? ''}:${mail?.progress?.done ?? ''}:${outgoing}`;
    })
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
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [bucket, setBucketState] = useState<string | null>(null);
  const [facets, setFacets] = useState<EmailThreadFacet[]>([]);
  const [needsReply, setNeedsReply] = useState(0);
  const [knownAccounts, setAccounts] = useState<EmailAccountSummary[] | null>(null);
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
  const [view, setViewState] = useState<EmailListView>('inbox');
  const [views, setViews] = useState<EmailViewCount[]>([]);
  const [search, setSearchState] = useState<string | null>(null);
  const [outgoing, setOutgoing] = useState<OutgoingChange[]>([]);
  const [superseded, setSuperseded] = useState<string | null>(null);
  // The changes made here, newest last, for Ctrl+Z.
  const done = useRef<number[][]>([]);

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
    const one = account === 'all' ? undefined : account;
    void (async () => {
      const [shown, counts, all, needs, sorted, ...each] = await Promise.all([
        search !== null
          ? client.search(search, one).then((found) => {
              // Search is narrowed by Bucket here; its counts are of what it found.
              const threads = bucket
                ? found.threads.filter((thread) => inBucket(thread.bucket?.bucketId ?? null, bucket))
                : found.threads;
              return { threads, total: threads.length, facets: facetsOf(found.threads) };
            })
          : client.threads({ ...(one ? { account: one } : {}), view, ...(bucket ? { bucket } : {}) }),
        client.views(one),
        client.threads({ limit: 1 }),
        client.threads({ view: 'inbox', bucket: NEEDS_REPLY, limit: 1 }),
        client.buckets(),
        ...ids.map((id) => client.threads({ account: id, limit: 1 })),
      ]);
      if (!live) return;
      setList(shown.threads);
      setTotal(shown.total);
      setFacets(shown.facets ?? []);
      setNeedsReply(needs.unreadThreads);
      setBuckets(sorted);
      setViews(counts.views);
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
  }, [client, account, accountIds, signature, version, knownAccounts, view, search, bucket]);

  const threads = useMemo(() => (list ?? []).filter((each) => include(each.latest)), [list, include]);
  const forProjectFilter = useMemo(() => (list ?? []).map((each) => each.latest), [list]);

  // The strip's counts: the view's threads (whatever the Bucket) the Project filter lets through.
  const bucketCounts = useMemo(() => {
    const counted = new Map<string, number>([['all', 0]]);
    for (const facet of facets) {
      const filing = facet.projectId ? { projectId: facet.projectId, filedBy: 'user' as const } : null;
      if (!include({ filing })) continue;
      const key = facet.bucketId ?? UNSORTED;
      counted.set(key, (counted.get(key) ?? 0) + facet.threads);
      counted.set('all', (counted.get('all') ?? 0) + facet.threads);
    }
    return counted;
  }, [facets, include]);

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

  // Whether the selected thread's changes reached their Source: read again whenever the threads are.
  const selectedItemIds = selected?.itemIds.join('|') ?? '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: `list` changing means the changes may have too
  useEffect(() => {
    let live = true;
    const ids = selectedItemIds ? selectedItemIds.split('|') : [];
    void client.outgoing(ids).then((found) => {
      if (live) setOutgoing(found);
    });
    // A change made in Gmail or Outlook that won over the User's, on any of its messages, until they change it again.
    void Promise.all(ids.map((id) => client.history(id))).then((histories) => {
      if (live) setSuperseded(histories.map(supersededNote).find((note) => note !== null) ?? null);
    });
    return () => {
      live = false;
    };
  }, [client, selectedItemIds, list]);

  // Does an action to a thread; `remember`: keep it for Ctrl+Z (not marking read on opening).
  const perform = useCallback(
    async (action: ThreadAction, target: EmailThreadSummary | null, remember: boolean) => {
      const thread = target ?? selected;
      if (!thread) return [];
      const found = await client.thread(thread.account, thread.threadKey);
      const messages = (found?.messages ?? []).flatMap(({ item }) =>
        item.detail?.kind === 'email' ? [{ id: item.id, detail: item.detail as EmailDetail }] : [],
      );
      const entries = await client.edit(threadActionFields(action, messages));
      reload();
      const ids = entries.map((entry) => entry.id);
      if (ids.length && remember) done.current.push(ids);
      return ids;
    },
    [client, selected, reload],
  );
  const act = useCallback(
    (action: ThreadAction, target?: EmailThreadSummary) => perform(action, target ?? null, true),
    [perform],
  );

  const setView = useCallback((next: EmailListView) => {
    setViewState(next);
    setSearchState(null);
    setSelectedId(null);
    setOpen(false);
  }, []);

  const setBucket = useCallback((next: string | null) => {
    setBucketState(next);
    setSelectedId(null);
  }, []);

  const setSearch = useCallback((text: string | null) => {
    setSearchState(text === null || !text.trim() ? null : text.trim());
    setSelectedId(null);
  }, []);

  // Opening a thread with unread mail marks it read, at once or after a moment (Settings → Email).
  const unreadOpen = open && selected && selected.unreadCount > 0 ? threadId(selected) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `perform` follows the selection, which `unreadOpen` names
  useEffect(() => {
    if (!unreadOpen) return;
    const delay = markReadDelay(loadMarkRead(storage));
    if (delay === null) return;
    const timer = setTimeout(() => void perform({ type: 'read' }, null, false), delay);
    return () => clearTimeout(timer);
  }, [unreadOpen, storage]);

  const sync = useMemo(() => threadSync(outgoing), [outgoing]);
  const retry = useCallback(async () => {
    for (const itemId of new Set(
      outgoing.filter((change) => change.status === 'failed').map((c) => c.itemId),
    ))
      await client.retry(itemId);
    reload();
  }, [client, outgoing, reload]);

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
    for (const each of knownAccounts) void accountsClient.refresh(each.id, mailSourceOf(each));
  }, [accountsClient, knownAccounts]);

  // A refresh asked for before the Accounts were read goes once they are.
  useEffect(() => {
    if (knownAccounts && refreshWanted.current) {
      refreshWanted.current = false;
      for (const each of knownAccounts) void accountsClient.refresh(each.id, mailSourceOf(each));
    }
  }, [accountsClient, knownAccounts]);

  const file = useCallback(
    async (projectId: string | null) => {
      if (!selected) return [];
      const entries = await client.file(selected.itemIds, projectId);
      reload();
      const ids = entries.map((entry) => entry.id);
      if (ids.length) done.current.push(ids);
      return ids;
    },
    [client, selected, reload],
  );

  const undo = useCallback(
    async (entryIds: number[]) => {
      done.current = done.current.filter((each) => each !== entryIds && each.join() !== entryIds.join());
      await client.undo(entryIds);
      reload();
    },
    [client, reload],
  );

  const undoLast = useCallback(async () => {
    const last = done.current.pop();
    if (!last) return;
    await client.undo(last);
    reload();
  }, [client, reload]);

  return {
    accounts,
    loaded: knownAccounts !== null && list !== null,
    account,
    setAccount,
    unread,
    needsReply,
    buckets,
    bucket,
    setBucket,
    bucketCounts,
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
    view,
    setView,
    views,
    search,
    setSearch,
    act,
    undoLast,
    sync,
    retry,
    superseded,
  };
}
