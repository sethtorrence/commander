import type { ActivityEntry, GitHubDiscussion, Item } from '@commander/domain';
import type { GitHubAccountSummary } from '@commander/domain/ipc';
import { toast } from '@commander/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ItemChanges } from '../../item-store/changes';
import { usePeople } from '../../people/context';
import type { GitHubAccountsClient, GitHubWork, WorkLink } from './github-work';
import {
  type FilterKey,
  type FilterOptions,
  filterOptions,
  groupWork,
  inFilters,
  inView,
  isOpen,
  NO_FILTERS,
  toWork,
  type Work,
  type WorkFilters,
  type WorkGroup,
  type WorkView,
} from './work';

export const VIEW_STORAGE_KEY = 'commander.github.view';

function loadView(storage: Storage): WorkView {
  try {
    return storage.getItem(VIEW_STORAGE_KEY) === 'issues' ? 'issues' : 'pulls';
  } catch {
    return 'pulls';
  }
}

/** Where the open pull request's or issue's discussion stands. */
export type DiscussionState =
  | { status: 'loading' }
  | { status: 'ready'; discussion: GitHubDiscussion }
  | { status: 'failed'; error: string };

export interface GitHubState {
  /** The GitHub Accounts, each with who signed in and how it is syncing. */
  accounts: GitHubAccountSummary[];
  /** Whether the work has loaded once. */
  loaded: boolean;
  /** Pull requests (the default) or Issues. Remembered across restarts. */
  view: WorkView;
  setView(view: WorkView): void;
  /** How much open work each view would list under the filters and the Project filter. */
  viewCounts: Record<WorkView, number>;
  filters: WorkFilters;
  setFilter(key: FilterKey, value: string | null): void;
  clearFilters(): void;
  /** Each GitHub filter's choices, with counts. */
  options: FilterOptions;
  /** The open work the GitHub filters let through in this view, for the Project filter's counts. */
  forProjectFilter: Work[];
  /** The listed work, grouped: open, then Closed (merged and closed). */
  groups: WorkGroup[];
  /** How much is listed open. */
  openCount: number;
  /** Whether the Closed group is expanded. It starts collapsed. */
  closedShown: boolean;
  showClosed(shown?: boolean): void;
  /** The selected pull request or issue: always one that is shown. */
  selected: Work | null;
  select(itemId: string): void;
  /** Selects and opens one, switching views, clearing the filters or showing Closed if they hide it. */
  reveal(itemId: string): void;
  moveSelection(step: 1 | -1): void;
  detailOpen: boolean;
  setDetailOpen(open: boolean): void;
  /** The selected one's activity log (newest first) and Links. */
  history: ActivityEntry[];
  links: WorkLink[];
  /** The open one's discussion, fetched when the detail pane opens it (and again once it changes). */
  discussion: DiscussionState | null;
  /** Every pull request and issue Commander holds, whatever the view and filters. */
  allWork: Work[];
  /** The pull requests (by Item id) where a review is asked of the User. */
  reviewAsked: ReadonlySet<string>;
  /** How many reviews are asked of the User and still waiting, for the notebook tab. */
  reviewsWaiting: number;
  /** Makes a change through another module (filing), so it reloads and can be undone here. */
  apply(change: () => Promise<ActivityEntry>): Promise<ActivityEntry | null>;
  /** Undoes one change made here: the given entry, or the latest not yet undone. */
  undo(entryId?: number): Promise<void>;
  /** Reads the work again. */
  reload(): void;
  /** Asks every connected GitHub Account to sync now (the sync engine's refresh). */
  refresh(): void;
}

// What changes when a sync finishes: each Account's last sync.
const syncSignature = (accounts: readonly GitHubAccountSummary[]) =>
  accounts.map((account) => `${account.id}:${account.sync?.lastSyncedAt ?? ''}`).join('|');

/**
 * The GitHub Section's state: the work and Accounts, the view, the filters (with the Project filter's
 * `include`), the selection and the open one's discussion. It reloads the work whenever a sync
 * finishes, after its own changes and on `reload`, and remembers its changes so they can be undone.
 */
export function useGitHub({
  work: client,
  accounts: accountsClient,
  include,
  storage = window.localStorage,
  changes,
}: {
  work: GitHubWork;
  accounts: GitHubAccountsClient;
  include: (item: Pick<Item, 'filing'>) => boolean;
  storage?: Storage;
  /** Word of Items changed elsewhere: work among them is read again (Ares filed it, say). */
  changes?: ItemChanges;
}): GitHubState {
  const [items, setItems] = useState<Item[] | null>(null);
  const [requests, setRequests] = useState<Item[]>([]);
  // null until the Accounts are first read.
  const [knownAccounts, setAccounts] = useState<GitHubAccountSummary[] | null>(null);
  const accounts = useMemo(() => knownAccounts ?? [], [knownAccounts]);
  const [refreshWanted, setRefreshWanted] = useState(false);
  const [view, setViewState] = useState<WorkView>(() => loadView(storage));
  const [filters, setFilters] = useState<WorkFilters>(NO_FILTERS);
  // People, so the author filter offers a Person once for all their GitHub logins.
  const people = usePeople();
  const [closedShown, setClosedShown] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [history, setHistory] = useState<ActivityEntry[]>([]);
  const [links, setLinks] = useState<WorkLink[]>([]);
  // Discussions by Item and version ("id@updatedAt"), so going back to one shows it at once.
  const [discussions, setDiscussions] = useState<ReadonlyMap<string, DiscussionState>>(new Map());
  const [version, setVersion] = useState(0);
  const undoable = useRef<number[]>([]);
  const lastIndex = useRef(0);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // Work changed elsewhere (Ares filed it, or left his dashed Badge on it) is read again, and so is a
  // review request coming or going.
  const known = useRef(new Set<string>());
  known.current = new Set([...(items ?? []), ...requests].map((item) => item.id));
  useEffect(
    () => changes?.((itemIds) => itemIds.some((id) => known.current.has(id)) && reload()),
    [changes, reload],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload
  useEffect(() => {
    let current = true;
    client.list().then((next) => current && setItems(next), report);
    client.reviewRequests().then((next) => current && setRequests(next), report);
    return () => {
      current = false;
    };
  }, [client, version]);

  // The Accounts, kept current; the work is read again whenever a sync finishes.
  const synced = useRef<string | null>(null);
  useEffect(() => {
    let current = true;
    const take = (next: GitHubAccountSummary[]) => {
      if (!current) return;
      setAccounts(next);
      const signature = syncSignature(next);
      if (synced.current !== null && synced.current !== signature) reload();
      synced.current = signature;
    };
    accountsClient.list().then(take, report);
    const stop = accountsClient.onChange(take);
    return () => {
      current = false;
      stop();
    };
  }, [accountsClient, reload]);

  const all = useMemo(() => toWork(items ?? []), [items]);
  const viewed = useMemo(() => all.filter((work) => inView(work, view)), [all, view]);
  const narrowed = useMemo(() => viewed.filter(include), [viewed, include]);
  const listed = useMemo(
    () => narrowed.filter((work) => inFilters(work, filters, undefined, people)),
    [narrowed, filters, people],
  );
  const groups = useMemo(() => groupWork(listed), [listed]);
  const options = useMemo(() => filterOptions(narrowed, filters, people), [narrowed, filters, people]);
  const forProjectFilter = useMemo(
    () => viewed.filter((work) => isOpen(work) && inFilters(work, filters, undefined, people)),
    [viewed, filters, people],
  );
  const viewCounts = useMemo(() => {
    const counted = all.filter(
      (work) => isOpen(work) && include(work) && inFilters(work, filters, undefined, people),
    );
    return {
      pulls: counted.filter((work) => inView(work, 'pulls')).length,
      issues: counted.filter((work) => inView(work, 'issues')).length,
    };
  }, [all, include, filters, people]);

  // The pull requests a waiting review request points at.
  const reviewAsked = useMemo(
    () =>
      new Set(
        requests.flatMap((request) =>
          request.detail?.kind === 'review-request' && request.detail.pullRequestId
            ? [request.detail.pullRequestId]
            : [],
        ),
      ),
    [requests],
  );

  const shown = useMemo(
    () => groups.flatMap((group) => (group.id === 'closed' && !closedShown ? [] : group.work)),
    [groups, closedShown],
  );
  const selected =
    shown.find((work) => work.id === selectedId) ??
    (detailOpen ? all.find((work) => work.id === selectedId) : undefined) ??
    shown[Math.min(lastIndex.current, shown.length - 1)] ??
    null;
  const selectedItemId = selected?.id ?? null;
  useEffect(() => {
    const index = selected ? shown.indexOf(selected) : -1;
    if (index >= 0) lastIndex.current = index;
  }, [selected, shown]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload after a change
  useEffect(() => {
    if (!selectedItemId) {
      setHistory([]);
      setLinks([]);
      return;
    }
    let current = true;
    client.history(selectedItemId).then((next) => current && setHistory(next), report);
    client.links(selectedItemId).then((next) => current && setLinks(next), report);
    return () => {
      current = false;
    };
  }, [client, selectedItemId, version]);

  // The discussion of the one open in the detail pane: once per version of the Item (the Core keeps
  // it until the Item changes), fetched again when a sync brings a change.
  const discussionKey = detailOpen && selected ? `${selected.id}@${selected.detail.updatedAt}` : null;
  const discussion = discussionKey ? (discussions.get(discussionKey) ?? { status: 'loading' }) : null;
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!discussionKey || asked.current.has(discussionKey)) return;
    asked.current.add(discussionKey);
    const itemId = discussionKey.slice(0, discussionKey.lastIndexOf('@'));
    const settle = (state: DiscussionState) =>
      setDiscussions((now) => new Map(now).set(discussionKey, state));
    settle({ status: 'loading' });
    client.discussion(itemId).then(
      (response) => {
        settle(
          response.ok
            ? { status: 'ready', discussion: response.discussion }
            : { status: 'failed', error: response.error },
        );
        // A failure may be asked about again (opening it again tries again).
        if (!response.ok) asked.current.delete(discussionKey);
      },
      (error: unknown) => {
        settle({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
        asked.current.delete(discussionKey);
      },
    );
  }, [client, discussionKey]);

  const setView = useCallback(
    (next: WorkView) => {
      setViewState(next);
      try {
        storage.setItem(VIEW_STORAGE_KEY, next);
      } catch {
        // Storage unavailable: the view still applies for this session.
      }
    },
    [storage],
  );

  const setFilter = useCallback(
    (key: FilterKey, value: string | null) => setFilters((now) => ({ ...now, [key]: value })),
    [],
  );
  const clearFilters = useCallback(() => setFilters(NO_FILTERS), []);

  const moveSelection = useCallback(
    (step: 1 | -1) => {
      if (!shown.length) return;
      const index = selected ? shown.indexOf(selected) : -1;
      const next = shown[Math.min(shown.length - 1, Math.max(0, index + step))];
      if (next) setSelectedId(next.id);
    },
    [shown, selected],
  );

  const showClosed = useCallback((value?: boolean) => setClosedShown((now) => value ?? !now), []);

  const reveal = useCallback(
    (itemId: string) => {
      // A review request opens its pull request.
      const request = requests.find((one) => one.id === itemId);
      const target =
        request?.detail?.kind === 'review-request' ? (request.detail.pullRequestId ?? itemId) : itemId;
      const work = all.find((one) => one.id === target);
      // Not read yet (it synced since): read again, and let nothing hide it meanwhile.
      if (!work) reload();
      if (work && !inView(work, view)) setView(inView(work, 'pulls') ? 'pulls' : 'issues');
      if (!work || !inFilters(work, filters, undefined, people)) setFilters(NO_FILTERS);
      if (!work || !isOpen(work)) setClosedShown(true);
      setSelectedId(target);
      setDetailOpen(true);
    },
    [requests, all, view, filters, reload, setView, people],
  );

  const apply = useCallback(
    async (change: () => Promise<ActivityEntry>) => {
      try {
        const entry = await change();
        undoable.current.push(entry.id);
        reload();
        return entry;
      } catch (error) {
        report(error);
        return null;
      }
    },
    [reload],
  );

  const undo = useCallback(
    async (entryId?: number) => {
      const target = entryId ?? undoable.current.at(-1);
      if (target === undefined) {
        toast('Nothing to undo here');
        return;
      }
      undoable.current = undoable.current.filter((id) => id !== target);
      try {
        await client.undo(target);
      } catch (error) {
        report(error);
      }
      reload();
    },
    [client, reload],
  );

  const refresh = useCallback(() => setRefreshWanted(true), []);
  useEffect(() => {
    if (!refreshWanted || knownAccounts === null) return;
    setRefreshWanted(false);
    for (const account of knownAccounts) {
      if (account.status === 'connected') accountsClient.syncNow(account.id).catch(report);
    }
  }, [refreshWanted, knownAccounts, accountsClient]);

  return {
    accounts,
    loaded: items !== null,
    view,
    setView,
    viewCounts,
    filters,
    setFilter,
    clearFilters,
    options,
    forProjectFilter,
    groups,
    openCount: listed.filter(isOpen).length,
    closedShown,
    showClosed,
    selected,
    select: setSelectedId,
    reveal,
    moveSelection,
    detailOpen,
    setDetailOpen,
    history,
    links,
    discussion,
    allWork: all,
    reviewAsked,
    reviewsWaiting: requests.length,
    apply,
    undo,
    reload,
    refresh,
  };
}

function report(error: unknown) {
  toast(error instanceof Error ? error.message : String(error));
}
