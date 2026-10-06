// Relays the window's requests for writing email (#138) to the Core and its replies back, validated both
// ways, like the updates channel; and, when Commander quits, asks the Core to send the messages held for
// Undo and waits for its answer (stopCoreOnQuit bounds the wait).
import {
  COMPOSE_MESSAGES,
  type ComposeOp,
  type ComposeResponse,
  composeRequest,
  composeResult,
  coreComposeReply,
} from '@commander/domain';
import { z } from 'zod';

type Pending = { op: ComposeOp; resolve: (response: ComposeResponse) => void; timer: NodeJS.Timeout };

// Opening a forward fetches its attachments through its Source; saving and sending may first clean the
// quote's HTML; an attachment's bytes are written to disk. The rest are quick database reads.
const TIMEOUTS: Record<ComposeOp, number> = {
  open: 120_000,
  'open-draft': 120_000,
  // Ares's suggested reply (#143): a reply's quote made and its draft saved.
  'open-suggested': 120_000,
  save: 60_000,
  send: 60_000,
  'undo-send': 10_000,
  discard: 10_000,
  retry: 10_000,
  drafts: 10_000,
  outbox: 10_000,
  suggest: 10_000,
  'add-attachment': 60_000,
  settings: 10_000,
  'save-settings': 10_000,
  signature: 10_000,
  'save-signature': 10_000,
};

const sentHeld = z.object({ type: z.literal(COMPOSE_MESSAGES.sentHeld), id: z.number().int().positive() });

export function createComposeChannel(send: (message: unknown) => void) {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const quitting = new Map<number, () => void>();

  return {
    // A request from the window.
    request(raw: unknown): Promise<ComposeResponse> {
      const parsed = composeRequest.safeParse(raw);
      if (!parsed.success)
        return Promise.resolve({ ok: false, error: `Rejected compose request: ${parsed.error.message}` });
      const id = nextId++;
      const { op } = parsed.data;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, error: 'The Core did not answer in time' });
        }, TIMEOUTS[op]);
        pending.set(id, { op, resolve, timer });
        send({ type: COMPOSE_MESSAGES.request, id, request: parsed.data });
      });
    },

    // Commander is quitting: resolves once the Core says the held messages have gone (or can't).
    sendHeld(): Promise<void> {
      const id = nextId++;
      return new Promise((resolve) => {
        quitting.set(id, resolve);
        send({ type: COMPOSE_MESSAGES.sendHeld, id });
      });
    },

    // A message from the Core. Returns true when it was one of compose's, handled here.
    settle(raw: unknown): boolean {
      const held = sentHeld.safeParse(raw);
      if (held.success) {
        quitting.get(held.data.id)?.();
        quitting.delete(held.data.id);
        return true;
      }
      const parsed = coreComposeReply.safeParse(raw);
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
      const result = composeResult[waiting.op].safeParse(response.result);
      waiting.resolve(
        result.success
          ? ({ ok: true, result: result.data } as ComposeResponse)
          : { ok: false, error: `Rejected a malformed compose reply from the Core: ${result.error.message}` },
      );
      return true;
    },
  };
}
