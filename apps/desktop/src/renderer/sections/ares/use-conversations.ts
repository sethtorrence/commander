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
  startNew(): Promise<void>;
  send(text: string): Promise<boolean>;
  stop(): Promise<void>;
  sendAgain(): Promise<void>;
  remove(conversation: Conversation): Promise<void>;
};

/**
 * Conversations with Ares, as the Ares Section shows them: the list, the open one (today's when the
 * Section opens on a new day), and Ares's answers streaming into it as core messages arrive.
 */
export function useConversations(
  client: ConversationsClient,
  shown: boolean,
  onCoreMessage: CoreMessages,
): ConversationsState {
  const [today, setToday] = useState(() => dayKey(new Date()));
  const [list, setList] = useState<Conversation[]>([]);
  const [view, setView] = useState<ConversationView | null>(null);
  const [live, setLive] = useState<ReadonlyMap<number, string>>(new Map());
  // Every turn the Core has pushed, the latest of each, so a reply that crossed one keeps the newer.
  const pushed = useRef(new Map<number, ConversationTurn>());
  const openId = useRef<string | null>(null);
  const landedOn = useRef<string | null>(null);

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

  // Opening the Section lands on today's Conversation, made on the first open of the day.
  useEffect(() => {
    if (!shown) return;
    const day = dayKey(new Date());
    setToday(day);
    if (landedOn.current === day && openId.current) {
      void reload();
      return;
    }
    landedOn.current = day;
    void ask(client({ op: 'today', day })).then((daily) => {
      if (daily) show(daily);
      void reload();
    });
  }, [shown, client, ask, show, reload]);

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
                ? { ...each, answering: turn.status === 'queued' || turn.status === 'streaming' }
                : each,
            ),
          );
        }
      }),
    [onCoreMessage],
  );

  const open = useCallback(
    async (conversationId: string) => {
      const opened = await ask(client({ op: 'open', conversationId }));
      if (opened) show(opened);
    },
    [client, ask, show],
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

  return { today, list, view, live, open, startNew, send, stop, sendAgain, remove };
}
