// Relays the window's requests for Ares's Updates to the Core and its replies back, validated both
// ways, like the models channel. The window can never enqueue: only the Core's producers do.
import {
  UPDATES_MESSAGES,
  type UpdatesOp,
  type UpdatesResponse,
  updatesRequest,
  updatesResult,
} from '@commander/domain';
import { z } from 'zod';

type Pending = { op: UpdatesOp; resolve: (response: UpdatesResponse) => void; timer: NodeJS.Timeout };

// Giving an Update may wait on a light Teams sync (5 seconds at most) and Deep model calls (the Core
// falls back to plain sentences after 45 seconds), and so may summarising a Chat; everything else
// is a quick database read.
const TIMEOUTS: Record<UpdatesOp, number> = {
  state: 10_000,
  'run-skill': 90_000,
  'summarise-chat': 90_000,
  'draft-reply': 90_000,
  // Ares writing a GitHub summary: the pull requests' detail fetched first, then a Deep call.
  'summarise-github': 150_000,
  // A Person's paragraph (#122): their pull requests' detail, then a Deep call.
  'refresh-person-paragraph': 150_000,
  history: 10_000,
  past: 10_000,
  act: 10_000,
  'act-row': 10_000,
};

const reply = z.object({
  type: z.literal(UPDATES_MESSAGES.reply),
  id: z.number().int().positive(),
  response: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), result: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
});

export function createUpdatesChannel(send: (message: unknown) => void) {
  let nextId = 1;
  const pending = new Map<number, Pending>();

  return {
    // A request from the window.
    request(raw: unknown): Promise<UpdatesResponse> {
      const parsed = updatesRequest.safeParse(raw);
      if (!parsed.success) {
        return Promise.resolve({ ok: false, error: `Rejected updates request: ${parsed.error.message}` });
      }
      const id = nextId++;
      const { op } = parsed.data;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, error: 'The Core did not answer in time' });
        }, TIMEOUTS[op]);
        pending.set(id, { op, resolve, timer });
        send({ type: UPDATES_MESSAGES.request, id, request: parsed.data });
      });
    },

    // A message from the Core. Returns true when it was an updates reply, handled here.
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
      const result = updatesResult[waiting.op].safeParse(response.result);
      waiting.resolve(
        result.success
          ? ({ ok: true, result: result.data } as UpdatesResponse)
          : { ok: false, error: `Rejected a malformed updates reply from the Core: ${result.error.message}` },
      );
      return true;
    },
  };
}
