// Relays Settings → Ares requests from the window to the Core and its replies back, validated both
// ways, like the Item store channel.
import {
  type CoreModelsRequest,
  coreModelsReply,
  type ModelsOp,
  type ModelsResponse,
  modelsRequest,
  modelsResult,
} from '@commander/domain';

type Pending = { op: ModelsOp; resolve: (response: ModelsResponse) => void; timer: NodeJS.Timeout };

// Test waits on the model, which may retry with back-off; everything else is a quick database read.
const TIMEOUTS: Record<ModelsOp, number> = {
  settings: 10_000,
  'save-settings': 10_000,
  usage: 10_000,
  test: 5 * 60_000,
};

export function createModelsChannel(send: (message: CoreModelsRequest) => void) {
  let nextId = 1;
  const pending = new Map<number, Pending>();

  return {
    // A request from the window.
    request(raw: unknown): Promise<ModelsResponse> {
      const parsed = modelsRequest.safeParse(raw);
      if (!parsed.success) {
        return Promise.resolve({ ok: false, error: `Rejected models request: ${parsed.error.message}` });
      }
      const id = nextId++;
      const { op } = parsed.data;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, error: 'The Core did not answer in time' });
        }, TIMEOUTS[op]);
        pending.set(id, { op, resolve, timer });
        send({ type: 'models-request', id, request: parsed.data });
      });
    },

    // A message from the Core. Returns true when it was a models reply, handled here.
    settle(raw: unknown): boolean {
      const parsed = coreModelsReply.safeParse(raw);
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
      const result = modelsResult[waiting.op].safeParse(response.result);
      waiting.resolve(
        result.success
          ? ({ ok: true, result: result.data } as ModelsResponse)
          : { ok: false, error: `Rejected a malformed models reply from the Core: ${result.error.message}` },
      );
      return true;
    },
  };
}
