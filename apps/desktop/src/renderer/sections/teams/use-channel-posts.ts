import type { ActivityEntry, Item } from '@commander/domain';
import type { TeamsAccountSummary } from '@commander/domain/ipc';
import { toast } from '@commander/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ItemChanges } from '../../item-store/changes';
import {
  type ChannelGroup,
  type ChannelPost,
  type ChannelPostsClient,
  channelGroups,
  isChannelPost,
  syncsChannelPosts,
  unseenCount,
} from './channel-posts';
import type { ChatLink, TeamsChats } from './teams-chats';
import type { MessageFocus } from './use-teams';

export interface ChannelPostsState {
  /** Whether any Teams Account syncs Channel posts: only then is there a Channels group at all. */
  shown: boolean;
  /** The posts, by team then channel, newest activity first (the Project filter applied). */
  groups: ChannelGroup[];
  /** How many posts have something from others the User hasn't seen. */
  unseen: number;
  /** The post open in the pane, if one is. */
  open: ChannelPost | null;
  /** Opens a post (at a message, when given: the Dashboard opens it at the mention), or closes it. */
  openPost(itemId: string | null, messageId?: string): void;
  /** The message the open post was asked to show; a new object for each ask. */
  focus: MessageFocus | null;
  /** The open post's activity log (newest first) and Links. */
  history: ActivityEntry[];
  links: ChatLink[];
  /** Replies to a post; resolves with whether the reply was taken (shown at once, sent in the background). */
  reply(post: ChannelPost, text: string): Promise<boolean>;
  reload(): void;
}

/**
 * The Teams Section's Channels group (#111): the posts of the Accounts that sync Channel posts, read
 * again whenever the Accounts change (a sync finished), an Item changes elsewhere, or on `reload`.
 * Opening a post with something unseen marks it seen (Commander's own mark, logged as the User's).
 */
export function useChannelPosts({
  client,
  chats,
  accounts,
  changes,
  include,
  apply,
}: {
  client: ChannelPostsClient | null;
  /** For a post's history and Links, as a Chat's (the same Item store requests). */
  chats: TeamsChats;
  accounts: readonly TeamsAccountSummary[];
  changes?: ItemChanges;
  include: (item: Pick<Item, 'filing'>) => boolean;
  /** Makes a change so the Section can undo it (a reply still queued is cancelled). */
  apply: (change: () => Promise<ActivityEntry>) => Promise<ActivityEntry | null>;
}): ChannelPostsState {
  const shown = !!client && accounts.some(syncsChannelPosts);
  const [items, setItems] = useState<Item[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [focusAsked, setFocusAsked] = useState<MessageFocus | null>(null);
  const [history, setHistory] = useState<ActivityEntry[]>([]);
  const [links, setLinks] = useState<ChatLink[]>([]);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` and `accounts` ask for a reload
  useEffect(() => {
    if (!client || !shown) {
      setItems([]);
      return;
    }
    let current = true;
    client.list().then((found) => current && setItems(found), report);
    return () => {
      current = false;
    };
  }, [client, shown, version, accounts]);

  useEffect(() => changes?.(() => reload()), [changes, reload]);

  const groups = useMemo(() => channelGroups(items, accounts, include), [items, accounts, include]);
  const meOf = useCallback(
    (post: ChannelPost) => accounts.find((account) => account.id === post.account)?.user?.id ?? null,
    [accounts],
  );
  const unseen = useMemo(
    () =>
      groups.reduce(
        (sum, group) => sum + group.posts.filter((post) => unseenCount(post, meOf(post)) > 0).length,
        0,
      ),
    [groups, meOf],
  );
  const open = useMemo(() => {
    if (!openId) return null;
    const found = items.find((item) => item.id === openId);
    return found && isChannelPost(found) ? found : null;
  }, [items, openId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload after a change
  useEffect(() => {
    if (!openId) {
      setHistory([]);
      setLinks([]);
      return;
    }
    let current = true;
    chats.history(openId).then((next) => current && setHistory(next), report);
    chats.links(openId).then((next) => current && setLinks(next), report);
    return () => {
      current = false;
    };
  }, [chats, openId, version]);

  const openPost = useCallback((itemId: string | null, messageId?: string) => {
    setOpenId(itemId);
    setFocusAsked((was) =>
      itemId && messageId ? { chatId: itemId, messageId, nonce: (was?.nonce ?? 0) + 1 } : null,
    );
    if (itemId) setVersion((v) => v + 1);
  }, []);
  const focus = focusAsked && open && focusAsked.chatId === open.id ? focusAsked : null;

  // Opening a post with something from others not seen yet marks it seen, once per opening.
  const seenOnOpen = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !client) {
      seenOnOpen.current = null;
      return;
    }
    if (seenOnOpen.current === open.id) return;
    seenOnOpen.current = open.id;
    if (unseenCount(open, meOf(open)) === 0) return;
    client.markSeen(open.id, Math.max(Date.now(), open.detail.lastActivityAt)).then(() => reload(), report);
  }, [open, client, meOf, reload]);

  const reply = useCallback(
    async (post: ChannelPost, text: string) => {
      if (!client) return false;
      const entry = await apply(() => client.reply(post.id, text));
      reload();
      return entry !== null;
    },
    [apply, client, reload],
  );

  return { shown, groups, unseen, open, openPost, focus, history, links, reply, reload };
}

function report(error: unknown) {
  toast(error instanceof Error ? error.message : String(error));
}
