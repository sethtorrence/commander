import { z } from 'zod';

// Messages the Core sends to the window.
// Every message crossing a process seam is validated against this contract.
const heartbeat = z.object({
  type: z.literal('heartbeat'),
  beats: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
});

// Ares did or suggested something (through the gate): views of his activity reload.
const aresActivity = z.object({ type: z.literal('ares-activity'), at: z.number().int().nonnegative() });

// Items were changed in the Item store (by the window, so far): open views showing them catch up.
const itemsChanged = z.object({
  type: z.literal('items-changed'),
  itemIds: z.array(z.string().min(1)).min(1),
});

export const coreMessage = z.discriminatedUnion('type', [heartbeat, aresActivity, itemsChanged]);
export type CoreMessage = z.infer<typeof coreMessage>;

export type CoreMessageParseResult = { ok: true; message: CoreMessage } | { ok: false; error: string };

export function parseCoreMessage(input: unknown): CoreMessageParseResult {
  const result = coreMessage.safeParse(input);
  return result.success ? { ok: true, message: result.data } : { ok: false, error: result.error.message };
}
