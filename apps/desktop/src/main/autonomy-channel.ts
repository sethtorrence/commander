// Relays requests for the gate to the Core and its replies back: the window's requests and, when
// test hooks are on, the end-to-end tests'. Both directions are validated: only well-formed requests
// reach the Core, and only well-formed results come back.
import {
  AUTONOMY_MESSAGES,
  autonomyRequest,
  autonomyResult,
  autonomyTestRequest,
  autonomyTestResult,
} from '@commander/domain';
import { z } from 'zod';

type Response = { ok: true; result: unknown } | { ok: false; error: string };
type Envelope = { request: string; reply: string };

const replyMessage = z.object({
  type: z.string(),
  id: z.number().int().positive(),
  response: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), result: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
});

function createChannel(
  envelope: Envelope,
  requestSchema: z.ZodType<{ op: string }>,
  results: Record<string, z.ZodType>,
  send: (message: unknown) => void,
  timeoutMs: number,
) {
  let nextId = 1;
  const pending = new Map<
    number,
    { op: string; resolve: (response: Response) => void; timer: NodeJS.Timeout }
  >();

  return {
    request(raw: unknown): Promise<Response> {
      const parsed = requestSchema.safeParse(raw);
      if (!parsed.success) {
        return Promise.resolve({ ok: false, error: `Rejected autonomy request: ${parsed.error.message}` });
      }
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, error: 'The Core did not answer in time' });
        }, timeoutMs);
        pending.set(id, { op: parsed.data.op, resolve, timer });
        send({ type: envelope.request, id, request: parsed.data });
      });
    },

    // A message from the Core. Returns true when it was this channel's reply, handled here.
    settle(raw: unknown): boolean {
      const parsed = replyMessage.safeParse(raw);
      if (!parsed.success || parsed.data.type !== envelope.reply) return false;
      const { id, response } = parsed.data;
      const waiting = pending.get(id);
      if (!waiting) return true;
      pending.delete(id);
      clearTimeout(waiting.timer);
      if (!response.ok) {
        waiting.resolve(response);
        return true;
      }
      const result = results[waiting.op]?.safeParse(response.result);
      waiting.resolve(
        result?.success
          ? { ok: true, result: result.data }
          : { ok: false, error: `Rejected malformed autonomy reply from the Core: ${result?.error.message}` },
      );
      return true;
    },
  };
}

export function createAutonomyChannels(
  send: (message: unknown) => void,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
) {
  return {
    window: createChannel(AUTONOMY_MESSAGES.window, autonomyRequest, autonomyResult, send, timeoutMs),
    test: createChannel(AUTONOMY_MESSAGES.test, autonomyTestRequest, autonomyTestResult, send, timeoutMs),
  };
}
