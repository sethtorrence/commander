import {
  type ChatDraft,
  type ChatReplySuggestion,
  type ChatTodoSuggestion,
  chatReplySuggestionOf,
  chatTodoSuggestionOf,
} from '@commander/domain';
import { toast } from '@commander/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { UpdatesClient } from '../../updates/updates';
import type { AutonomyClient } from '../ares/activity';

/*
  Ares's work on Chats in the Teams Section (#110), as the Chat view shows it:

  - Suggested Todos: his pending "Suggest Todos" suggestions on a Chat, each a card beside the message
    it came from, with Add (the User accepts it, through the gate) and Dismiss (for good: he doesn't
    offer it again for that message).
  - A suggested reply: his pending "Reply in Teams" suggestion for a Chat waiting on the User, a card
    above the reply box with the full draft. Send accepts it through the gate, which sends the reply
    as the User's through the outgoing queue; Edit moves the draft into the reply box (the suggestion
    is settled, and the User sends their own words as any reply); Dismiss drops it.
  - Draft: Ares drafts a reply on request (the Core's Draft Skill, through the Updates bridge), which
    goes in the reply box. Nothing is ever sent without the User pressing Send.
*/

export interface ChatWorkClient {
  /** Ares's suggestions waiting on Chats: Todos and replies. */
  suggestions(): Promise<{ todos: ChatTodoSuggestion[]; replies: ChatReplySuggestion[] }>;
  /** Accepts a suggestion (Add a Todo, Send a reply): one at a time. */
  accept(proposalId: number): Promise<void>;
  dismiss(proposalId: number): Promise<void>;
  /** Ares drafts a reply to a Chat, for the reply box. */
  draft(itemId: string): Promise<ChatDraft>;
  /** Called whenever Ares did or suggested something. Returns the unsubscribe. */
  onAresChange(listener: () => void): () => void;
}

type Bridge = { autonomy: AutonomyClient; updates: UpdatesClient } & Partial<
  Pick<Window['commander'], 'onCoreMessage'>
>;

export function chatWorkIn(bridge: Bridge): ChatWorkClient {
  const { autonomy, updates } = bridge;
  return {
    async suggestions() {
      const pending = await autonomy({
        op: 'activity',
        query: { section: 'teams', statuses: ['pending'], limit: 500 },
      });
      // Oldest first.
      const rows = [...pending].reverse();
      return {
        todos: rows.flatMap((row) => chatTodoSuggestionOf(row) ?? []),
        replies: rows.flatMap((row) => chatReplySuggestionOf(row) ?? []),
      };
    },
    async accept(proposalId) {
      await autonomy({ op: 'accept', proposalId });
    },
    async dismiss(proposalId) {
      await autonomy({ op: 'dismiss', proposalId });
    },
    draft: (itemId) => updates({ op: 'draft-reply', itemId }),
    onAresChange(listener) {
      return (
        bridge.onCoreMessage?.((message) => {
          if (message.type === 'ares-activity') listener();
        }) ?? (() => {})
      );
    },
  };
}

export interface ChatWork {
  /** The open Chat's suggested Todos, by the message each came from. */
  todosByMessage: ReadonlyMap<string, ChatTodoSuggestion[]>;
  /** The open Chat's suggested reply, if Ares prepared one. */
  reply: ChatReplySuggestion | null;
  /** Whether Ares is drafting a reply for the open Chat. */
  drafting: boolean;
  /** Accepts a suggestion (Add a Todo, Send a reply): true once done, false when it failed (said in a toast). */
  accept(proposalId: number): Promise<boolean>;
  dismiss(proposalId: number): Promise<void>;
  /** Ares drafts a reply for the open Chat: the draft, or null when he couldn't (said in a toast). */
  draft(): Promise<{ chatId: string; text: string } | null>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Ares's suggestions and drafts for the open Chat, read again whenever he does or suggests something. */
export function useChatWork(client: ChatWorkClient | undefined, chatId: string | null): ChatWork {
  const [todos, setTodos] = useState<ChatTodoSuggestion[]>([]);
  const [replies, setReplies] = useState<ChatReplySuggestion[]>([]);
  const [draftingFor, setDraftingFor] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => client?.onAresChange(reload), [client, reload]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload
  useEffect(() => {
    if (!client || !chatId) return;
    let live = true;
    client.suggestions().then(
      (found) => {
        if (!live) return;
        setTodos(found.todos);
        setReplies(found.replies);
      },
      (error) => toast(message(error)),
    );
    return () => {
      live = false;
    };
  }, [client, chatId, version]);

  const todosByMessage = useMemo(() => {
    const map = new Map<string, ChatTodoSuggestion[]>();
    for (const todo of todos) {
      if (todo.chatId !== chatId) continue;
      map.set(todo.messageId, [...(map.get(todo.messageId) ?? []), todo]);
    }
    return map;
  }, [todos, chatId]);
  const reply = replies.find((each) => each.chatId === chatId) ?? null;

  // The card goes at once; a failure brings it back with the reason.
  const settle = useCallback(
    async (proposalId: number, op: 'accept' | 'dismiss'): Promise<boolean> => {
      if (!client) return false;
      setTodos((was) => was.filter((each) => each.proposalId !== proposalId));
      setReplies((was) => was.filter((each) => each.proposalId !== proposalId));
      try {
        await (op === 'accept' ? client.accept(proposalId) : client.dismiss(proposalId));
        return true;
      } catch (error) {
        toast(message(error));
        return false;
      } finally {
        reload();
      }
    },
    [client, reload],
  );

  const draft = useCallback(async () => {
    const chat = chatId;
    if (!client || !chat) return null;
    setDraftingFor(chat);
    try {
      const { text } = await client.draft(chat);
      return { chatId: chat, text };
    } catch (error) {
      toast(message(error));
      return null;
    } finally {
      setDraftingFor((was) => (was === chat ? null : was));
    }
  }, [client, chatId]);

  return {
    todosByMessage,
    reply,
    drafting: draftingFor !== null && draftingFor === chatId,
    accept: (proposalId) => settle(proposalId, 'accept'),
    dismiss: async (proposalId) => {
      await settle(proposalId, 'dismiss');
    },
    draft,
  };
}
