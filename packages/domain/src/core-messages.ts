import { z } from 'zod';

// Messages the Core sends to the window.
// Every message crossing a process seam is validated against this contract.
const heartbeat = z.object({
  type: z.literal('heartbeat'),
  beats: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
});

export const coreMessage = z.discriminatedUnion('type', [heartbeat]);
export type CoreMessage = z.infer<typeof coreMessage>;

export type CoreMessageParseResult = { ok: true; message: CoreMessage } | { ok: false; error: string };

export function parseCoreMessage(input: unknown): CoreMessageParseResult {
  const result = coreMessage.safeParse(input);
  return result.success ? { ok: true, message: result.data } : { ok: false, error: result.error.message };
}
