// Relays the window's requests about Conversations with Ares to the Core and its replies back,
// validated both ways, like the updates channel. Ares's answers themselves stream to the window as
// core messages (conversation-tokens, conversation-turn), not through here.
import {
  CONVERSATIONS_MESSAGES,
  type ConversationsOp,
  type ConversationsResponse,
  conversationsRequest,
  conversationsResult,
} from '@commander/domain';
import { z } from 'zod';

type Pending = {
  op: ConversationsOp;
  resolve: (response: ConversationsResponse) => void;
  timer: NodeJS.Timeout;
};

// Every request is answered at once from the database, except Stop and Delete, which first wait for an
// answer being written to end (a moment).
const TIMEOUTS: Record<ConversationsOp, number> = {
  list: 10_000,
  today: 10_000,
  new: 10_000,
  open: 10_000,
  send: 10_000,
  retry: 10_000,
  stop: 20_000,
  delete: 20_000,
  'undo-delete': 10_000,
  skills: 10_000,
  'undo-remembered': 10_000,
};

const reply = z.object({
  type: z.literal(CONVERSATIONS_MESSAGES.reply),
  id: z.number().int().positive(),
  response: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), result: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
});

export function createConversationsChannel(send: (message: unknown) => void) {
  let nextId = 1;
  const pending = new Map<number, Pending>();

  return {
    // A request from the window.
    request(raw: unknown): Promise<ConversationsResponse> {
      const parsed = conversationsRequest.safeParse(raw);
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: `Rejected conversations request: ${parsed.error.message}`,
        });
      }
      const id = nextId++;
      const { op } = parsed.data;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, error: 'The Core did not answer in time' });
        }, TIMEOUTS[op]);
        pending.set(id, { op, resolve, timer });
        send({ type: CONVERSATIONS_MESSAGES.request, id, request: parsed.data });
      });
    },

    // A message from the Core. Returns true when it was a conversations reply, handled here.
    settle(raw: unknown): boolean {
      const parsed = reply.safeParse(raw);
      if (!parsed.success) return false;
      const { id, response } = parsed.data;
      const waiting = pending.get(id);
      if (!waiting) return true;
      pending.delete(id);
      clearTimeout(waiting.timer);
      if (!response.ok) {
        waiting.resolve(response);
        return true;
      }
      const result = conversationsResult[waiting.op].safeParse(response.result);
      waiting.resolve(
        result.success
          ? ({ ok: true, result: result.data } as ConversationsResponse)
          : {
              ok: false,
              error: `Rejected a malformed conversations reply from the Core: ${result.error.message}`,
            },
      );
      return true;
    },
  };
}
