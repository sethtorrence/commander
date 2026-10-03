// Relays the window's Item store requests to the Core and its replies back. Both directions are
// validated: the window can only send well-formed requests, and only well-formed results reach it.
import {
  type CoreItemStoreRequest,
  coreItemStoreReply,
  type ItemStoreOp,
  type ItemStoreResponse,
  itemStoreRequest,
  itemStoreResult,
} from '@commander/domain';

type Pending = { op: ItemStoreOp; resolve: (response: ItemStoreResponse) => void; timer: NodeJS.Timeout };

export function createItemStoreChannel(
  send: (message: CoreItemStoreRequest) => void,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
) {
  let nextId = 1;
  const pending = new Map<number, Pending>();

  return {
    // A request from the window.
    request(raw: unknown): Promise<ItemStoreResponse> {
      const parsed = itemStoreRequest.safeParse(raw);
      if (!parsed.success) {
        return Promise.resolve({ ok: false, error: `Rejected Item store request: ${parsed.error.message}` });
      }
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, error: 'The Core did not answer in time' });
        }, timeoutMs);
        pending.set(id, { op: parsed.data.op, resolve, timer });
        send({ type: 'item-store-request', id, request: parsed.data });
      });
    },

    // A message from the Core. Returns true when it was an Item store reply, handled here.
    settle(raw: unknown): boolean {
      const parsed = coreItemStoreReply.safeParse(raw);
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
      const result = itemStoreResult[waiting.op].safeParse(response.result);
      waiting.resolve(
        result.success
          ? ({ ok: true, result: result.data } as ItemStoreResponse)
          : {
              ok: false,
              error: `Rejected malformed Item store reply from the Core: ${result.error.message}`,
            },
      );
      return true;
    },
  };
}

export type ItemStoreChannel = ReturnType<typeof createItemStoreChannel>;
