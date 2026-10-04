import type { ActivityEntry, Item, LinearCatalog, OutgoingChange } from '@commander/domain';
import type { AccountSummary } from '@commander/domain/ipc';
import { toast } from '@commander/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type IssueSync, issueSync } from './editing';
import {
  type AccountsById,
  type FilterKey,
  type FilterOptions,
  filterOptions,
  groupIssues,
  type Issue,
  type IssueFilters,
  type IssueGroup,
  type IssueView,
  inFilters,
  inView,
  isMine,
  isOpen,
  NO_FILTERS,
  toIssues,
} from './issues';
import type { IssueLink, LinearAccountsClient, LinearIssues } from './linear-issues';

export const VIEW_STORAGE_KEY = 'commander.linear.view';

function loadView(storage: Storage): IssueView {
  try {
    return storage.getItem(VIEW_STORAGE_KEY) === 'all' ? 'all' : 'mine';
  } catch {
    return 'mine';
  }
}

export interface LinearState {
  /** The Linear Accounts, each with who signed in and how it is syncing. */
  accounts: AccountSummary[];
  accountsById: AccountsById;
  /** Whether the issues have loaded once. */
  loaded: boolean;
  /** Assigned to me (the default) or All tickets. Remembered across restarts. */
  view: IssueView;
  setView(view: IssueView): void;
  /** How many open issues each view would list under the filters, for the view switch. */
  viewCounts: Record<IssueView, number>;
  filters: IssueFilters;
  setFilter(key: FilterKey, value: string | null): void;
  clearFilters(): void;
  /** Each Linear filter's choices, with counts. */
  options: FilterOptions;
  /** The open issues the Linear filters let through in this view, for the Project filter's counts. */
  forProjectFilter: Issue[];
  /** The listed issues, grouped: started, unstarted, backlog and triage, closed. */
  groups: IssueGroup[];
  /** How many issues are listed open (not closed). */
  openCount: number;
  /** Open issues assigned to the User, whatever the filters, for the notebook tab. */
  assignedCount: number;
  /** Whether the Closed group is expanded. It starts collapsed. */
  closedShown: boolean;
  showClosed(shown?: boolean): void;
  /** The selected issue: always one that is shown. */
  selected: Issue | null;
  select(itemId: string): void;
  /** Selects and opens an issue, switching to All tickets, clearing the filters or showing Closed if they hide it. */
  reveal(itemId: string): void;
  moveSelection(step: 1 | -1): void;
  detailOpen: boolean;
  setDetailOpen(open: boolean): void;
  /** The selected issue's activity log (newest first) and Links. */
  history: ActivityEntry[];
  links: IssueLink[];
  /** Every issue Commander holds, whatever the view and filters (for the pickers' choices). */
  allIssues: Issue[];
  /** What each Account's Linear offers the pickers, by Account; null until its first sync. */
  catalogs: ReadonlyMap<string, LinearCatalog | null>;
  /** Where an issue's own changes stand: in Linear, on their way, or couldn't sync. */
  syncOf(itemId: string): IssueSync;
  /** Changes some of the selected issue's synced fields; undoable here. */
  edit(fields: Record<string, unknown>): Promise<void>;
  /** Posts a comment on the selected issue, as the User; undoable here (which deletes it in Linear). */
  comment(body: string): Promise<boolean>;
  /** Sends the selected issue's changes that couldn't sync again. */
  retry(): Promise<void>;
  /** Makes a change through another module (filing), so it reloads and can be undone here. */
  apply(change: () => Promise<ActivityEntry>): Promise<ActivityEntry | null>;
  /** Undoes one change made here: the given entry, or the latest not yet undone. */
  undo(entryId?: number): Promise<void>;
  /** Reads the issues again. */
  reload(): void;
  /** Asks every connected Linear Account to sync now (the sync engine's refresh). */
  refresh(): void;
}

// What changes when a sync finishes, or a change made here reaches Linear or fails: each Account's
// last sync and outgoing changes.
const syncSignature = (accounts: readonly AccountSummary[]) =>
  accounts
    .map((account) => {
      const outgoing = account.sync?.outgoing;
      return `${account.id}:${account.sync?.lastSyncedAt ?? ''}:${outgoing?.pending ?? 0}/${outgoing?.failed ?? 0}`;
    })
    .join('|');

/**
 * The Linear Section's state: the issues and Accounts, the view, the filters (with the Project
 * filter's `include`) and the selection. It reloads the issues whenever a sync finishes, after its
 * own changes and on `reload`, and remembers its changes so they can be undone in turn.
 */
export function useLinear({
  issues,
  accounts: accountsClient,
  include,
  now,
  storage = window.localStorage,
}: {
  issues: LinearIssues;
  accounts: LinearAccountsClient;
  include: (item: Pick<Item, 'filing'>) => boolean;
  now: number;
  storage?: Storage;
}): LinearState {
  const [items, setItems] = useState<Item[] | null>(null);
  const [outgoing, setOutgoing] = useState<OutgoingChange[]>([]);
  const [catalogs, setCatalogs] = useState<ReadonlyMap<string, LinearCatalog | null>>(new Map());
  // null until the Accounts are first read.
  const [knownAccounts, setAccounts] = useState<AccountSummary[] | null>(null);
  const accounts = useMemo(() => knownAccounts ?? [], [knownAccounts]);
  // A refresh asked for before the Accounts were read waits for them.
  const [refreshWanted, setRefreshWanted] = useState(false);
  const [view, setViewState] = useState<IssueView>(() => loadView(storage));
  const [filters, setFilters] = useState<IssueFilters>(NO_FILTERS);
  const [closedShown, setClosedShown] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [history, setHistory] = useState<ActivityEntry[]>([]);
  const [links, setLinks] = useState<IssueLink[]>([]);
  const [version, setVersion] = useState(0);
  const undoable = useRef<number[]>([]);
  const lastIndex = useRef(0);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload
  useEffect(() => {
    let current = true;
    issues.list().then((next) => current && setItems(next), report);
    issues.outgoing().then((next) => current && setOutgoing(next), report);
    return () => {
      current = false;
    };
  }, [issues, version]);

  // What each Account's Linear offers the pickers, read again after each sync.
  const catalogKey = syncSignature(accounts);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `catalogKey` asks for a reread after a sync
  useEffect(() => {
    let current = true;
    Promise.all(
      accounts.map(async (account) => [account.id, await issues.catalog(account.id)] as const),
    ).then((found) => current && setCatalogs(new Map(found)), report);
    return () => {
      current = false;
    };
  }, [issues, catalogKey]);

  // The Accounts, kept current; the issues are read again whenever a sync finishes.
  const synced = useRef<string | null>(null);
  useEffect(() => {
    let current = true;
    const take = (next: AccountSummary[]) => {
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

  const accountsById = useMemo<AccountsById>(
    () =>
      new Map(
        accounts.map((account) => [account.id, { id: account.id, name: account.name, user: account.user }]),
      ),
    [accounts],
  );

  const all = useMemo(() => toIssues(items ?? []), [items]);
  const viewed = useMemo(
    () => all.filter((issue) => inView(issue, view, accountsById)),
    [all, view, accountsById],
  );
  const narrowed = useMemo(() => viewed.filter(include), [viewed, include]);
  const listed = useMemo(
    () => narrowed.filter((issue) => inFilters(issue, filters, now)),
    [narrowed, filters, now],
  );
  const groups = useMemo(() => groupIssues(listed), [listed]);
  const options = useMemo(
    () => filterOptions(narrowed, filters, now, accountsById),
    [narrowed, filters, now, accountsById],
  );
  const forProjectFilter = useMemo(
    () => viewed.filter((issue) => isOpen(issue) && inFilters(issue, filters, now)),
    [viewed, filters, now],
  );
  const viewCounts = useMemo(() => {
    const counted = all.filter((issue) => isOpen(issue) && include(issue) && inFilters(issue, filters, now));
    return { all: counted.length, mine: counted.filter((issue) => isMine(issue, accountsById)).length };
  }, [all, include, filters, now, accountsById]);
  const assignedCount = useMemo(
    () => all.filter((issue) => isOpen(issue) && isMine(issue, accountsById)).length,
    [all, accountsById],
  );

  const shown = useMemo(
    () => groups.flatMap((group) => (group.id === 'closed' && !closedShown ? [] : group.issues)),
    [groups, closedShown],
  );
  // An issue open in the detail pane stays open when an edit moves it out of the list (closing it
  // into the collapsed Closed group, say), rather than the pane jumping to another issue.
  const selected =
    shown.find((issue) => issue.id === selectedId) ??
    (detailOpen ? all.find((issue) => issue.id === selectedId) : undefined) ??
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
    issues.history(selectedItemId).then((next) => current && setHistory(next), report);
    issues.links(selectedItemId).then((next) => current && setLinks(next), report);
    return () => {
      current = false;
    };
  }, [issues, selectedItemId, version]);

  const setView = useCallback(
    (next: IssueView) => {
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
      const issue = all.find((one) => one.id === itemId);
      // Not read yet (it synced since): read again, and let nothing hide it meanwhile.
      if (!issue) reload();
      if (!issue || !inView(issue, view, accountsById)) setViewState('all');
      if (!issue || !inFilters(issue, filters, now)) setFilters(NO_FILTERS);
      if (!issue || !isOpen(issue)) setClosedShown(true);
      setSelectedId(itemId);
      setDetailOpen(true);
    },
    [all, view, accountsById, filters, now, reload],
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
        await issues.undo(target);
      } catch (error) {
        report(error);
      }
      reload();
    },
    [issues, reload],
  );

  const outgoingByItem = useMemo(() => {
    const byItem = new Map<string, OutgoingChange[]>();
    for (const change of outgoing) byItem.set(change.itemId, [...(byItem.get(change.itemId) ?? []), change]);
    return byItem;
  }, [outgoing]);
  const syncOf = useCallback(
    (itemId: string) => issueSync(outgoingByItem.get(itemId) ?? []),
    [outgoingByItem],
  );

  const edit = useCallback(
    async (fields: Record<string, unknown>) => {
      if (!selectedItemId) return;
      await apply(() => issues.edit(selectedItemId, fields));
    },
    [apply, issues, selectedItemId],
  );

  // The User's own Linear user in the issue's workspace, as the comment's author until Linear's arrives.
  const selectedAccount = selected?.account ?? null;
  const comment = useCallback(
    async (body: string) => {
      if (!selectedItemId || !body.trim()) return false;
      const me = selectedAccount ? accountsById.get(selectedAccount)?.user : null;
      const author = me ? { id: me.id, name: me.name, displayName: me.name, email: null } : null;
      return (await apply(() => issues.comment(selectedItemId, body.trim(), author))) !== null;
    },
    [apply, issues, selectedItemId, selectedAccount, accountsById],
  );

  const retry = useCallback(async () => {
    if (!selectedItemId) return;
    try {
      await issues.retry(selectedItemId);
    } catch (error) {
      report(error);
    }
    reload();
  }, [issues, selectedItemId, reload]);

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
    accountsById,
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
    assignedCount,
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
    allIssues: all,
    catalogs,
    syncOf,
    edit,
    comment,
    retry,
    apply,
    undo,
    reload,
    refresh,
  };
}

function report(error: unknown) {
  toast(error instanceof Error ? error.message : String(error));
}
