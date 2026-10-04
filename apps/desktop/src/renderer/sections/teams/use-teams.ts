import type { ActivityEntry, ChatSetting, ChatSettingChangeKind, Item } from '@commander/domain';
import type { TeamsAccountSummary } from '@commander/domain/ipc';
import { toast } from '@commander/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ItemChanges } from '../../item-store/changes';
import {
  type Chat,
  type ChatCounts,
  type ChatFilters,
  chatCounts,
  inFilters,
  NO_FILTERS,
  orderChats,
  toChats,
  unreadChats,
} from './chats';
import type { ChatLink, TeamsAccountsClient, TeamsChats } from './teams-chats';

export interface TeamsState {
  /** The Teams Accounts, each with who signed in and how it is syncing. */
  accounts: TeamsAccountSummary[];
  /** Whether the Chats have loaded once. */
  loaded: boolean;
  filters: ChatFilters;
  setFilters(change: Partial<ChatFilters>): void;
  /** Each filter's counts under the other one and the Project filter. */
  counts: ChatCounts;
  /** The Chats the Teams filters let through, for the Project filter's counts. */
  forProjectFilter: Chat[];
  /** The listed Chats, in order: unread mentions, unread, the rest. */
  chats: Chat[];
  /** Unread, unmuted Chats, whatever the filters (the notebook tab's count). */
  unreadCount: number;
  /** How many Chats Commander holds, whatever the filters. */
  total: number;
  /** The selected Chat: always one that is listed, unless it is open. */
  selected: Chat | null;
  select(itemId: string): void;
  /** Selects and opens a Chat, clearing the filters if they hide it. */
  reveal(itemId: string): void;
  moveSelection(step: 1 | -1): void;
  open: boolean;
  setOpen(open: boolean): void;
  /** The selected Chat's activity log (newest first) and Links. */
  history: ActivityEntry[];
  links: ChatLink[];
  /** The User's Teams user id in the Account a Chat came from. */
  meIn(chat: Chat): string | null;
  /** Mutes, unmutes or excludes a Chat; mute and unmute can be undone here. */
  changeSetting(chat: Chat, change: Exclude<ChatSettingChangeKind, 'include'>): Promise<void>;
  /** Makes a change through another module (filing), so it reloads and can be undone here. */
  apply(change: () => Promise<ActivityEntry>): Promise<ActivityEntry | null>;
  /** Undoes one change made here: the given entry, or the latest not yet undone. */
  undo(entryId?: number): Promise<void>;
  reload(): void;
  /** Asks every connected Teams Account for a light sync now (the sync engine's refresh). */
  refresh(): void;
}

// A change made here that can be undone: an activity entry (filing), or a mute to reverse.
type Undoable = { kind: 'entry'; entryId: number } | { kind: 'mute'; chat: Chat; muted: boolean };

// What changes when a sync finishes: each Account's last sync.
const syncSignature = (accounts: readonly TeamsAccountSummary[]) =>
  accounts.map((account) => `${account.id}:${account.sync?.lastSyncedAt ?? ''}`).join('|');

/**
 * The Teams Section's state: the Chats, the User's settings for them and the Accounts, the filters
 * (with the Project filter's `include`) and the selection. It reads the Chats again whenever a sync
 * finishes, an Item changes elsewhere, after its own changes and on `reload`, and remembers its
 * changes so they can be undone in turn.
 */
export function useTeams({
  chats: client,
  accounts: accountsClient,
  changes,
  include,
}: {
  chats: TeamsChats;
  accounts: TeamsAccountsClient;
  changes?: ItemChanges;
  include: (item: Pick<Item, 'filing'>) => boolean;
}): TeamsState {
  const [items, setItems] = useState<Item[] | null>(null);
  const [settings, setSettings] = useState<ChatSetting[]>([]);
  const [knownAccounts, setAccounts] = useState<TeamsAccountSummary[] | null>(null);
  const accounts = useMemo(() => knownAccounts ?? [], [knownAccounts]);
  const [refreshWanted, setRefreshWanted] = useState(false);
  const [filters, setFilterState] = useState<ChatFilters>(NO_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<ActivityEntry[]>([]);
  const [links, setLinks] = useState<ChatLink[]>([]);
  const [version, setVersion] = useState(0);
  const undoable = useRef<Undoable[]>([]);
  const lastIndex = useRef(0);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload
  useEffect(() => {
    let current = true;
    Promise.all([client.list(), client.settings()]).then(([nextItems, nextSettings]) => {
      if (!current) return;
      setItems(nextItems);
      setSettings(nextSettings);
    }, report);
    return () => {
      current = false;
    };
  }, [client, version]);

  // Chats changed elsewhere (filed from the palette, excluded in Settings): read them again.
  useEffect(() => changes?.(() => reload()), [changes, reload]);

  // The Accounts, kept current; the Chats are read again whenever a sync finishes.
  const synced = useRef<string | null>(null);
  useEffect(() => {
    let current = true;
    const take = (next: TeamsAccountSummary[]) => {
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

  const all = useMemo(() => orderChats(toChats(items ?? [], settings)), [items, settings]);
  const narrowed = useMemo(() => all.filter(include), [all, include]);
  const chats = useMemo(() => narrowed.filter((chat) => inFilters(chat, filters)), [narrowed, filters]);
  const counts = useMemo(() => chatCounts(narrowed, filters), [narrowed, filters]);
  const forProjectFilter = useMemo(() => all.filter((chat) => inFilters(chat, filters)), [all, filters]);
  const unreadCount = useMemo(() => unreadChats(all), [all]);

  // An open Chat stays open when a change moves it out of the list (muting it under Unread only).
  const selected =
    chats.find((chat) => chat.id === selectedId) ??
    (open ? all.find((chat) => chat.id === selectedId) : undefined) ??
    chats[Math.min(lastIndex.current, chats.length - 1)] ??
    null;
  const selectedItemId = selected?.id ?? null;
  useEffect(() => {
    const index = selected ? chats.indexOf(selected) : -1;
    if (index >= 0) lastIndex.current = index;
  }, [selected, chats]);

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

  const setFilters = useCallback(
    (change: Partial<ChatFilters>) => setFilterState((now) => ({ ...now, ...change })),
    [],
  );

  const moveSelection = useCallback(
    (step: 1 | -1) => {
      if (!chats.length) return;
      const index = selected ? chats.indexOf(selected) : -1;
      const next = chats[Math.min(chats.length - 1, Math.max(0, index + step))];
      if (next) setSelectedId(next.id);
    },
    [chats, selected],
  );

  const reveal = useCallback(
    (itemId: string) => {
      const chat = all.find((one) => one.id === itemId);
      if (!chat) reload();
      if (!chat || !inFilters(chat, filters)) setFilterState(NO_FILTERS);
      setSelectedId(itemId);
      setOpen(true);
    },
    [all, filters, reload],
  );

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

  const setMuted = useCallback(
    async (chat: Chat, muted: boolean) => {
      if (!chat.account || !chat.externalId) return false;
      await client.change({
        account: chat.account,
        chatId: chat.externalId,
        change: muted ? 'mute' : 'unmute',
      });
      return true;
    },
    [client],
  );

  const undo = useCallback(
    async (entryId?: number) => {
      const target =
        entryId === undefined
          ? undoable.current.at(-1)
          : (undoable.current.find((each) => each.kind === 'entry' && each.entryId === entryId) ??
            ({ kind: 'entry', entryId } as const));
      if (!target) {
        toast('Nothing to undo here');
        return;
      }
      undoable.current = undoable.current.filter((each) => each !== target);
      try {
        if (target.kind === 'entry') await client.undo(target.entryId);
        else await setMuted(target.chat, !target.muted);
      } catch (error) {
        report(error);
      }
      reload();
    },
    [client, reload, setMuted],
  );

  const changeSetting = useCallback(
    async (chat: Chat, change: Exclude<ChatSettingChangeKind, 'include'>) => {
      if (!chat.account || !chat.externalId) return;
      try {
        if (change === 'exclude') {
          await client.change({ account: chat.account, chatId: chat.externalId, change });
          toast(`Excluded from Commander: ${chat.title}. Include it again in Settings → Teams.`);
          if (selectedId === chat.id) setOpen(false);
        } else {
          const muted = change === 'mute';
          await setMuted(chat, muted);
          const done: Undoable = { kind: 'mute', chat, muted };
          undoable.current.push(done);
          toast(muted ? `Muted: ${chat.title}` : `Unmuted: ${chat.title}`, {
            action: {
              label: 'Undo',
              onClick: () => {
                undoable.current = undoable.current.filter((each) => each !== done);
                setMuted(chat, !muted).then(reload, report);
              },
            },
          });
        }
      } catch (error) {
        report(error);
      }
      reload();
    },
    [client, reload, selectedId, setMuted],
  );

  const meIn = useCallback(
    (chat: Chat) => accounts.find((account) => account.id === chat.account)?.user?.id ?? null,
    [accounts],
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
    filters,
    setFilters,
    counts,
    forProjectFilter,
    chats,
    unreadCount,
    total: all.length,
    selected,
    select: setSelectedId,
    reveal,
    moveSelection,
    open,
    setOpen,
    history,
    links,
    meIn,
    changeSetting,
    apply,
    undo,
    reload,
    refresh,
  };
}

function report(error: unknown) {
  toast(error instanceof Error ? error.message : String(error));
}
