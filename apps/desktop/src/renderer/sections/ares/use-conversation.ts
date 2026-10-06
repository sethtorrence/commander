import { type ConversationTurn, type ConversationView, withTokens } from '@commander/domain';
import { toast } from '@commander/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '../../projects/change-with-undo';
import { dayKey } from '../notes/days';
import { type ConversationsClient, withPushedTurns, withTurn } from './conversations';
import type { CoreMessages } from './use-conversations';

export type ConversationState = {
  view: ConversationView | null;
  // Ares's answer as he writes it, by turn: what has arrived so far.
  live: ReadonlyMap<number, string>;
  // The User's message: the first starts the Conversation, about the Item.
  send(text: string): Promise<boolean>;
  // The Conversation's id, starting it (with nothing said yet) if the User hasn't written: for Expand.
  start(): Promise<string | null>;
  stop(): Promise<void>;
  sendAgain(): Promise<void>;
};

/**
 * One Conversation about an Item, as the Ares button's pop-up holds it (#193): nothing is made until
 * the User sends their first message, which starts a new Conversation about `about` and is its first
 * turn; Ares's answers then stream in as core messages arrive. The pop-up mounts it afresh for each
 * press of the button.
 */
export function useConversation(
  client: ConversationsClient,
  onCoreMessage: CoreMessages,
  about: string,
): ConversationState {
  const [view, setView] = useState<ConversationView | null>(null);
  const [live, setLive] = useState<ReadonlyMap<number, string>>(new Map());
  const pushed = useRef(new Map<number, ConversationTurn>());
  const openId = useRef<string | null>(null);

  const show = useCallback((next: ConversationView | null) => {
    openId.current = next?.conversation.id ?? null;
    setView(next ? withPushedTurns(next, pushed.current) : null);
  }, []);

  const ask = useCallback(async <T>(request: Promise<T>): Promise<T | null> => {
    try {
      return await request;
    } catch (reason) {
      toast(errorText(reason));
      return null;
    }
  }, []);

  useEffect(
    () =>
      onCoreMessage((message) => {
        if (message.type === 'conversation-tokens') {
          if (message.conversationId !== openId.current) return;
          setLive((current) =>
            new Map(current).set(message.turnId, withTokens(current.get(message.turnId) ?? '', message)),
          );
        } else if (message.type === 'conversation-turn') {
          const { turn } = message;
          pushed.current.set(turn.id, turn);
          if (turn.conversationId !== openId.current) return;
          setView((current) => (current ? withTurn(current, turn) : current));
          if (turn.status !== 'queued' && turn.status !== 'streaming') {
            setLive((current) => {
              if (!current.has(turn.id)) return current;
              const next = new Map(current);
              next.delete(turn.id);
              return next;
            });
          }
        } else if (message.type === 'core-restarted') {
          // A new Core settled any answer the old one was writing when it stopped (#200).
          setLive(new Map());
          const conversationId = openId.current;
          if (conversationId) void client({ op: 'open', conversationId }).then(show, () => {});
        }
      }),
    [onCoreMessage, client, show],
  );

  const start = useCallback(async () => {
    if (openId.current) return openId.current;
    const made = await ask(client({ op: 'new', day: dayKey(new Date()), about }));
    if (!made) return null;
    show(made);
    return made.conversation.id;
  }, [client, ask, show, about]);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim()) return false;
      const conversationId = await start();
      if (!conversationId) return false;
      const sent = await ask(client({ op: 'send', conversationId, text }));
      if (sent && sent.conversation.id === openId.current) show(sent);
      return sent !== null;
    },
    [client, ask, show, start],
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
    if (again && again.conversation.id === openId.current) show(again);
  }, [client, ask, show]);

  return { view, live, send, start, stop, sendAgain };
}
