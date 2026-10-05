import {
  type ActivityEntry,
  aresRanker,
  type ChatSetting,
  type DashboardBand,
  type DashboardState,
  type Item,
  mutedChatIds,
  type Ranker,
  type Ranking,
  rankingOrigin,
} from '@commander/domain';
import type { AccountSummary } from '@commander/domain/ipc';
import { toast } from '@commander/ui';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useProjectFilter } from '../../projects/context';
import { type DashboardClient, forgetClears, loadClears, syncSignature, usersOf } from './dashboard';
import {
  type BandCounts,
  bandCounts,
  type Clears,
  clearHolds,
  clearRow,
  type FeedRow,
  feedRows,
  keepClears,
} from './feed';
import { type SuggestedTodo, withSuggestions } from './suggested-todos';

/*
  "What needs you" for the whole window: the frame mounts one <DashboardProvider>, and the Dashboard
  Section, the header's band meter and a Project page read it through `useDashboard()`. It reads the
  open Items (Teams Chats among them, less the muted ones) and the Linear and Teams Accounts, and
  from the Core Ares's ranking, the cleared rows and his pending suggested Todos. It ranks with Ares's ranking, falling back to the band rules for what he
  hasn't ranked and whenever his ranking can't be used (aresRanker), and keeps the cleared rows (in
  the Core, so Ares leaves them out) and the rows ticked here. It reads again after every sync, when
  Ares ranks again or suggests something, when another Section or page is opened, when the window
  regains focus, after its own changes, and ranks again every minute, as the time moves Items between
  bands.
*/

export interface DashboardApi {
  /** Whether the Items and Accounts have loaded once. */
  loaded: boolean;
  /** The time the list was last ranked at. */
  rankedAt: Date;
  /** Who ranked it: Ares (and when he did), or the rules (and why, when Ares can't). */
  rankedBy: { by: 'ares' | 'rules'; at: Date | null; why: string | null };
  /** Every row on the Dashboard, whatever the Project filter: ranked, not cleared, plus rows ticked here. */
  rows: readonly FeedRow[];
  /** The rows the Project filter lets through. */
  shown: readonly FeedRow[];
  /** Open rows in each band, under the Project filter: the header's band meter. */
  counts: BandCounts;
  /** How many rows under the Project filter are cleared from the Dashboard. */
  cleared: number;
  /** Open Commander Todos under the Project filter: the side column's link. */
  openTodos: number;
  /** Today's and tomorrow's events, for the side column's schedule. */
  events: readonly Item[];
  /** Ticks a Todo, or unticks one ticked here; a ticked row stays, struck through, until the Dashboard is left. */
  tick(row: FeedRow): Promise<void>;
  /**
   * Clears a row from the Dashboard: it stays in its Section, and comes back if its band changes (a
   * Chat: when it gets a newer qualifying message).
   */
  clear(row: FeedRow): void;
  /** Brings back every row cleared under the Project filter. */
  bringBack(): void;
  /** Adds a suggested Todo of Ares's (accepts it), or dismisses it for good. */
  settleSuggestion(row: FeedRow, op: 'accept' | 'dismiss'): Promise<void>;
  /** Makes a change through another module (filing), so the list reads again and it can be undone. */
  apply(change: () => Promise<ActivityEntry>): Promise<ActivityEntry | null>;
  /** Undoes a change made here: the given entry, or the latest not yet undone (ticks, clears, filing). */
  undo(entryId?: number): Promise<void>;
  /** The Dashboard was left: rows ticked here go. */
  leave(): void;
  /** Reads everything again. */
  reload(): void;
  /** Asks every connected Teams Account for a light sync: opening the Dashboard checks Teams. */
  refreshTeams(): void;
  /** What today's Daily Note holds so far (its top Blocks' text), or null with none yet. */
  dailyNote(day: string): Promise<string[] | null>;
  /** The band the header asked to jump to, as a new object each time. */
  jump: { band: DashboardBand } | null;
  jumpToBand(band: DashboardBand): void;
}

const DashboardContext = createContext<DashboardApi | null>(null);

// A change made here that can be undone: an activity entry, or a change to the cleared rows.
type Undoable = { kind: 'entry'; entryId: number; itemId?: string } | { kind: 'clears'; before: Clears };

const MINUTE = 60_000;

export function DashboardProvider({
  client,
  open,
  ranker,
  storage = window.localStorage,
  clock = Date.now,
  children,
}: {
  client: DashboardClient;
  /** What the frame has open (a Section's id, Settings, a Project page): a change reads everything again. */
  open?: string;
  /** How the open Items are ranked; Ares's ranking from the Core (falling back to the band rules) unless given. */
  ranker?: Ranker;
  storage?: Storage;
  clock?: () => number;
  children: ReactNode;
}) {
  const { include } = useProjectFilter();
  const [items, setItems] = useState<Item[] | null>(null);
  const [chatSettings, setChatSettings] = useState<ChatSetting[]>([]);
  const [accounts, setAccounts] = useState<AccountSummary[] | null>(null);
  const [core, setCore] = useState<DashboardState | null>(null);
  const [suggested, setSuggested] = useState<{ item: Item; suggestion: SuggestedTodo }[]>([]);
  const [clears, setClears] = useState<Clears>({});
  const [tickedHere, setTickedHere] = useState<ReadonlyMap<string, FeedRow>>(new Map());
  const [now, setNow] = useState(clock);
  const [version, setVersion] = useState(0);
  const [jump, setJump] = useState<{ band: DashboardBand } | null>(null);
  const undoable = useRef<Undoable[]>([]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload
  useEffect(() => {
    let current = true;
    Promise.all([client.items(), client.state(), client.suggestions(), client.chatSettings()]).then(
      ([next, state, pending, settings]) => {
        if (!current) return;
        setItems(next);
        setChatSettings(settings);
        setCore(state);
        setClears(state.clears);
        setSuggested(pending);
        setNow(clock());
      },
      report,
    );
    return () => {
      current = false;
    };
  }, [client, version]);

  // Rows cleared before the Core kept them move there, once.
  useEffect(() => {
    const legacy = loadClears(storage);
    if (!Object.keys(legacy).length) return;
    client.state().then(
      (state) =>
        client.saveClears({ ...legacy, ...state.clears }).then(() => {
          forgetClears(storage);
          reload();
        }),
      report,
    );
  }, [client, storage, reload]);

  // Ares ranked again, or suggested something.
  useEffect(() => client.onAresChange(reload), [client, reload]);

  // The Accounts, kept current; the Items are read again whenever a sync finishes.
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
    client.accounts.list().then(take, report);
    const stop = client.accounts.onChange(take);
    return () => {
      current = false;
      stop();
    };
  }, [client, reload]);

  // Another Section or page opened, or the window back in focus: changes made there show here.
  const opened = useRef(open);
  useEffect(() => {
    if (opened.current !== open) reload();
    opened.current = open;
  }, [open, reload]);
  useEffect(() => {
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);
  // The time moves Items between bands (overdue at midnight, FYI after a day).
  useEffect(() => {
    const timer = setInterval(() => setNow(clock()), MINUTE);
    return () => clearInterval(timer);
  }, [clock]);

  const loaded = items !== null && accounts !== null && core !== null;
  const users = useMemo(() => usersOf(accounts ?? []), [accounts]);
  // Muted Chats never reach the Dashboard, whoever ranked them.
  const muted = useMemo(() => mutedChatIds(items ?? [], chatSettings), [items, chatSettings]);
  const rank = useMemo(() => ranker ?? aresRanker(core?.ranking ?? null), [ranker, core]);
  const origin = rankingOrigin(ranker ? null : (core?.ranking ?? null), now);
  // The open Items, with Ares's suggested Todos as the Todos they would add.
  const ranked = useMemo(() => [...(items ?? []), ...suggested.map(({ item }) => item)], [items, suggested]);
  const rankings = useMemo<Ranking[]>(() => {
    if (!loaded) return [];
    // The suggestions Ares has ranked (into a band or none) stay where he put them.
    const decided = new Set(
      origin.by === 'ares' ? (core?.ranking.entries.map((entry) => entry.itemId) ?? []) : [],
    );
    return withSuggestions(rank(ranked, { now, users, muted }), suggested, decided);
  }, [loaded, rank, ranked, now, users, muted, suggested, origin.by, core]);
  const suggestions = useMemo(
    () => new Map(suggested.map(({ item, suggestion }) => [item.id, suggestion])),
    [suggested],
  );

  const changeClears = useCallback(
    (next: Clears) => {
      setClears(next);
      client.saveClears(next).catch(report);
    },
    [client],
  );

  // Clears whose Item moved to another band are forgotten, so the row is back.
  useEffect(() => {
    if (!loaded) return;
    const kept = keepClears(clears, rankings, now, ranked, users);
    if (kept !== clears) changeClears(kept);
  }, [loaded, clears, rankings, now, ranked, users, changeClears]);

  const rows = useMemo(
    () => feedRows(rankings, ranked, clears, tickedHere, suggestions, { users, now }),
    [rankings, ranked, clears, tickedHere, suggestions, users, now],
  );
  const shown = useMemo(() => rows.filter((row) => include(row.item)), [rows, include]);
  const counts = useMemo(() => bandCounts(shown), [shown]);
  const byId = useMemo(() => new Map(ranked.map((item) => [item.id, item])), [ranked]);
  const hidden = useMemo(
    () =>
      rankings.filter((ranking) => {
        const item = byId.get(ranking.itemId);
        return (
          item && clearHolds(clears[ranking.itemId], ranking.band, item, { users, now }) && include(item)
        );
      }),
    [rankings, byId, clears, include, users, now],
  );
  const openTodos = useMemo(
    () => (items ?? []).filter((item) => item.kind === 'todo' && include(item)).length,
    [items, include],
  );
  const events = useMemo(() => (items ?? []).filter((item) => item.kind === 'event'), [items]);

  const clearsNow = useRef(clears);
  clearsNow.current = clears;

  const undo = useCallback(
    async (entryId?: number) => {
      const stack = undoable.current;
      const index =
        entryId === undefined
          ? stack.length - 1
          : stack.findIndex((change) => change.kind === 'entry' && change.entryId === entryId);
      const change = stack[index];
      if (!change) {
        // A toast's Undo for an entry no longer on the stack (undone with Ctrl+Z, say) is still honoured.
        if (entryId === undefined) toast('Nothing to undo here');
        else await client.undo(entryId).then(reload, report);
        return;
      }
      undoable.current = stack.filter((_, i) => i !== index);
      if (change.kind === 'clears') {
        changeClears(change.before);
        return;
      }
      const { itemId } = change;
      if (itemId)
        setTickedHere((now) => {
          const next = new Map(now);
          next.delete(itemId);
          return next;
        });
      await client.undo(change.entryId).catch(report);
      reload();
    },
    [client, reload, changeClears],
  );

  // The Todo behind each Linear row ticked here, by issue id, for unticking it again.
  const tickedTodos = useRef(new Map<string, string>());

  const tick = useCallback(
    async (row: FeedRow) => {
      const { item } = row;
      if (row.suggestion) {
        toast(`Ares only suggested this: Add it (A) to make it a Todo`);
        return;
      }
      if (item.kind === 'event') {
        toast(`${item.title} is a meeting: open it (Enter) or clear it (E)`);
        return;
      }
      if (item.kind === 'chat') {
        toast('A Chat has nothing to tick: open it (Enter) to answer, or clear it (E)');
        return;
      }
      if (item.kind === 'email') {
        toast('An email has nothing to tick: open it (Enter) to answer, or clear it (E)');
        return;
      }
      // A Linear row is a Linear Todo's issue: ticking ticks that Todo, which moves the issue.
      const todoId =
        item.kind === 'todo'
          ? item.id
          : (tickedTodos.current.get(item.id) ??
            items?.find((each) => each.detail?.kind === 'todo' && each.detail.backedBy === item.id)?.id);
      if (!todoId) {
        if (item.source === 'github') {
          toast(`${item.title} has nothing to tick: open it (Enter), or clear it (E)`);
          return;
        }
        const name = item.detail?.kind === 'linear-issue' ? item.detail.identifier : item.title;
        toast(`${name} isn’t one of your Linear Todos yet: change its state in the Linear Section`);
        return;
      }
      if (todoId !== item.id) tickedTodos.current.set(item.id, todoId);
      const done = !row.done;
      let entry: ActivityEntry;
      try {
        entry = await client.setDone(todoId, done);
      } catch (error) {
        report(error);
        return;
      }
      undoable.current.push({ kind: 'entry', entryId: entry.id, itemId: item.id });
      setTickedHere((now) => {
        const next = new Map(now);
        if (done) next.set(item.id, { ...row, item: { ...item, status: 'done' }, done: true });
        else next.delete(item.id);
        return next;
      });
      reload();
      toast(`Todo ${done ? 'ticked' : 'unticked'}: ${item.title}`, {
        action: { label: 'Undo', onClick: () => void undo(entry.id) },
      });
    },
    [client, items, reload, undo],
  );

  const restoreClears = useCallback(
    (before: Clears) => {
      undoable.current = undoable.current.filter(
        (change) => !(change.kind === 'clears' && change.before === before),
      );
      changeClears(before);
    },
    [changeClears],
  );

  const clear = useCallback(
    (row: FeedRow) => {
      if (row.done) {
        setTickedHere((now) => {
          const next = new Map(now);
          next.delete(row.item.id);
          return next;
        });
        return;
      }
      const before = clearsNow.current;
      undoable.current.push({ kind: 'clears', before });
      changeClears(clearRow(before, row, clock()));
      toast(`Cleared from the Dashboard: ${row.item.title}. It’s still in its Section.`, {
        action: { label: 'Undo', onClick: () => restoreClears(before) },
      });
    },
    [changeClears, clock, restoreClears],
  );

  const bringBack = useCallback(() => {
    const before = clearsNow.current;
    const back = new Set(hidden.map((ranking) => ranking.itemId));
    if (!back.size) return;
    undoable.current.push({ kind: 'clears', before });
    changeClears(Object.fromEntries(Object.entries(before).filter(([itemId]) => !back.has(itemId))));
    toast(`Back on the Dashboard: ${back.size} ${back.size === 1 ? 'row' : 'rows'}`, {
      action: { label: 'Undo', onClick: () => restoreClears(before) },
    });
  }, [hidden, changeClears, restoreClears]);

  const apply = useCallback(
    async (change: () => Promise<ActivityEntry>) => {
      try {
        const entry = await change();
        undoable.current.push({ kind: 'entry', entryId: entry.id });
        reload();
        return entry;
      } catch (error) {
        report(error);
        return null;
      }
    },
    [reload],
  );

  const settleSuggestion = useCallback(
    async (row: FeedRow, op: 'accept' | 'dismiss') => {
      const { suggestion } = row;
      if (!suggestion) return;
      // The row goes at once; a failure brings it back with the reason.
      setSuggested((was) => was.filter((each) => each.suggestion.proposalId !== suggestion.proposalId));
      try {
        await client.settle(suggestion.proposalId, op);
        toast(op === 'accept' ? `Todo added: ${row.item.title}` : `Dismissed: ${row.item.title}`);
      } catch (error) {
        report(error);
      }
      reload();
    },
    [client, reload],
  );

  const leave = useCallback(() => setTickedHere((now) => (now.size ? new Map() : now)), []);
  const refreshTeams = useCallback(() => {
    client.refreshTeams().catch(report);
  }, [client]);
  const jumpToBand = useCallback((band: DashboardBand) => setJump({ band }), []);

  const api = useMemo<DashboardApi>(
    () => ({
      loaded,
      rankedAt: new Date(now),
      rankedBy: { by: origin.by, at: origin.at === null ? null : new Date(origin.at), why: origin.why },
      rows,
      shown,
      counts,
      cleared: hidden.length,
      openTodos,
      events,
      tick,
      clear,
      bringBack,
      settleSuggestion,
      apply,
      undo,
      leave,
      reload,
      refreshTeams,
      dailyNote: client.dailyNote,
      jump,
      jumpToBand,
    }),
    [
      client,
      refreshTeams,
      loaded,
      now,
      origin.by,
      origin.at,
      origin.why,
      rows,
      shown,
      counts,
      hidden,
      openTodos,
      events,
      tick,
      clear,
      bringBack,
      settleSuggestion,
      apply,
      undo,
      leave,
      reload,
      jump,
      jumpToBand,
    ],
  );

  return <DashboardContext.Provider value={api}>{children}</DashboardContext.Provider>;
}

export function useDashboard(): DashboardApi {
  const api = useContext(DashboardContext);
  if (!api) throw new Error('useDashboard needs a <DashboardProvider> above it');
  return api;
}

/** The Dashboard where there may be none (a component test of a Project page): null then. */
export function useDashboardIfAny(): DashboardApi | null {
  return useContext(DashboardContext);
}

function report(error: unknown) {
  toast(error instanceof Error ? error.message : String(error));
}
