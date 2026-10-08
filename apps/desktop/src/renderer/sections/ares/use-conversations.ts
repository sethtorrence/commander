import {
  type Conversation,
  type ConversationTurn,
  type ConversationView,
  type CoreMessage,
  withTokens,
} from '@commander/domain';
import { toast } from '@commander/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '../../projects/change-with-undo';
import { dayKey } from '../notes/days';
import { type ConversationsClient, nameOf, withPushedTurns, withTurn } from './conversations';

/** Hears the Core's messages (window.commander.onCoreMessage, or a test's stand-in). */
export type CoreMessages = (listener: (message: CoreMessage) => void) => () => void;

export type ConversationsState = {
  today: string;
  list: Conversation[];
  view: ConversationView | null;
  // Ares's answers as he writes them, by turn: what has arrived so far.
  live: ReadonlyMap<number, string>;
  open(conversationId: string): Promise<void>;
  // Opens a Conversation the Ares button's pop-up moved here (#193), whatever day it is.
  reveal(conversationId: string): Promise<void>;
  startNew(): Promise<void>;
  send(text: string): Promise<boolean>;
  stop(): Promise<void>;
  sendAgain(): Promise<void>;
  remove(conversation: Conversation): Promise<void>;
};

/**
 * Conversations with Ares, as the Ares Section and the Ares panel (#235) show them: the list, the
 * open one, and Ares's answers streaming in as core messages arrive, for every Conversation at once,
 * so switching to another never loses what he is writing in one. The Ares Section lands on today's
 * Conversation when it opens on a new day. The panel passes `remembered`, the Conversation it had
 * open (null for none): it lands on that one when first shown (today's when it is gone), then stays
 * wherever the User leaves it, whatever the day.
 */
export function useConversations(
  client: ConversationsClient,
  shown: boolean,
  onCoreMessage: CoreMessages,
  { remembered }: { remembered?: string | null } = {},
): ConversationsState {
  const [today, setToday] = useState(() => dayKey(new Date()));
  const [list, setList] = useState<Conversation[]>([]);
  const [view, setView] = useState<ConversationView | null>(null);
  const [live, setLive] = useState<ReadonlyMap<number, string>>(new Map());
  // Every turn the Core has pushed, the latest of each, so a reply that crossed one keeps the newer.
  const pushed = useRef(new Map<number, ConversationTurn>());
  const openId = useRef<string | null>(null);
  const landedOn = useRef<string | null>(null);
  const stays = remembered !== undefined;
  const first = useRef(remembered ?? null);
  const showing = useRef(shown);
  showing.current = shown;

  const show = useCallback((next: ConversationView | null) => {
    openId.current = next?.conversation.id ?? null;
    setView(next ? withPushedTurns(next, pushed.current) : null);
  }, []);

  const reload = useCallback(
    () =>
      client({ op: 'list' }).then(setList, (reason: unknown) => {
        toast(errorText(reason));
      }),
    [client],
  );

  const ask = useCallback(async <T>(request: Promise<T>): Promise<T | null> => {
    try {
      return await request;
    } catch (reason) {
      toast(errorText(reason));
      return null;
    }
  }, []);

  // Opening the Section lands on today's Conversation, made on the first open of the day; the panel
  // on the one it had open.
  useEffect(() => {
    if (!shown) return;
    const day = dayKey(new Date());
    setToday(day);
    if ((landedOn.current === day || (stays && landedOn.current)) && openId.current) {
      void reload();
      return;
    }
    landedOn.current = day;
    const before = openId.current;
    const kept = stays && first.current;
    const landing = kept
      ? client({ op: 'open', conversationId: kept }).catch(() => null)
      : Promise.resolve(null);
    void landing
      .then((view) => view ?? ask(client({ op: 'today', day })))
      .then((view) => {
        // Unless the User (or a link) opened another meanwhile.
        if (view && openId.current === before) show(view);
        void reload();
      });
  }, [shown, stays, client, ask, show, reload]);

  // Ares's answers as he writes them, and his turns as they change.
  useEffect(
    () =>
      onCoreMessage((message) => {
        if (message.type === 'conversation-tokens') {
          setLive((current) =>
            new Map(current).set(message.turnId, withTokens(current.get(message.turnId) ?? '', message)),
          );
        } else if (message.type === 'conversation-turn') {
          const { turn } = message;
          pushed.current.set(turn.id, turn);
          if (turn.conversationId === openId.current)
            setView((current) => (current ? withTurn(current, turn) : current));
          if (turn.status !== 'queued' && turn.status !== 'streaming') {
            setLive((current) => {
              if (!current.has(turn.id)) return current;
              const next = new Map(current);
              next.delete(turn.id);
              return next;
            });
          }
          setList((current) =>
            current.map((each) =>
              each.id === turn.conversationId
                ? {
                    ...each,
                    answering: turn.status === 'queued' || turn.status === 'streaming',
                    failed: turn.status === 'failed',
                  }
                : each,
            ),
          );
        } else if (message.type === 'ares-activity') {
          // A card of his may be waiting for the User now, or settled (#196): the list says so.
          if (showing.current) void reload();
        } else if (message.type === 'core-restarted') {
          // A new Core settled any answer the old one was writing when it stopped (#200).
          setLive(new Map());
          void reload();
          const conversationId = openId.current;
          if (conversationId) void client({ op: 'open', conversationId }).then(show, () => {});
        }
      }),
    [onCoreMessage, client, reload, show],
  );

  const open = useCallback(
    async (conversationId: string) => {
      const opened = await ask(client({ op: 'open', conversationId }));
      if (opened) show(opened);
    },
    [client, ask, show],
  );

  const reveal = useCallback(
    async (conversationId: string) => {
      // Shown now instead of today's, which opening the Section would otherwise land on.
      landedOn.current = dayKey(new Date());
      openId.current = conversationId;
      await open(conversationId);
      await reload();
    },
    [open, reload],
  );

  const startNew = useCallback(async () => {
    const made = await ask(client({ op: 'new', day: dayKey(new Date()) }));
    if (made) show(made);
    await reload();
  }, [client, ask, show, reload]);

  const send = useCallback(
    async (text: string) => {
      const conversationId = openId.current;
      if (!conversationId || !text.trim()) return false;
      const sent = await ask(client({ op: 'send', conversationId, text }));
      if (sent) show(sent);
      await reload();
      return sent !== null;
    },
    [client, ask, show, reload],
  );

  const stop = useCallback(async () => {
    const conversationId = openId.current;
    if (!conversationId) return;
    const stopped = await ask(client({ op: 'stop', conversationId }));
    if (stopped && stopped.conversation.id === openId.current) show(stopped);
  }, [client, ask, show]);

  const sendAgain = useCallback(async () => {
    const conversationId = openId.current;
    if (!conversationId) return;
    const again = await ask(client({ op: 'retry', conversationId }));
    if (again) show(again);
    await reload();
  }, [client, ask, show, reload]);

  const remove = useCallback(
    async (conversation: Conversation) => {
      const done = await ask(client({ op: 'delete', conversationId: conversation.id }));
      if (!done) return;
      const wasOpen = openId.current === conversation.id;
      const left = await client({ op: 'list' }).catch(() => [] as Conversation[]);
      setList(left);
      if (wasOpen) {
        const next = left[0];
        if (next) await open(next.id);
        else {
          const daily = await ask(client({ op: 'today', day: dayKey(new Date()) }));
          show(daily);
          await reload();
        }
      }
      toast(`Deleted ${nameOf(conversation, dayKey(new Date()))}`, {
        duration: 12_000,
        action: {
          label: 'Undo',
          onClick: () =>
            void ask(client({ op: 'undo-delete', conversationId: conversation.id })).then((back) => {
              if (back) show(back);
              void reload();
            }),
        },
      });
    },
    [client, ask, open, show, reload],
  );

  return { today, list, view, live, open, reveal, startNew, send, stop, sendAgain, remove };
}
