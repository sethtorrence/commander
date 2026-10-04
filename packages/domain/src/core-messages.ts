import { z } from 'zod';
import { aresStatus } from './agent';
import { markdownCopyStatus } from './markdown-copy-messages';

// Messages the Core sends to the window.
// Every message crossing a process seam is validated against this contract.
const heartbeat = z.object({
  type: z.literal('heartbeat'),
  beats: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
});

// Ares did or suggested something (through the gate): views of his activity reload.
const aresActivity = z.object({ type: z.literal('ares-activity'), at: z.number().int().nonnegative() });

// Ares started or finished a job: the Ares status module shows him working or idle.
const aresStatusChanged = aresStatus.extend({ type: z.literal('ares-status') });

// Ares's "Rank the Dashboard" job finished a run: the Dashboard reads its ranking again (his, or the
// rules' when he couldn't rank it).
const dashboardRanked = z.object({ type: z.literal('dashboard-ranked'), at: z.number().int().nonnegative() });

// Items were changed in the Item store (by the window, a sync, or Ares through the gate): open
// views showing them catch up.
const itemsChanged = z.object({
  type: z.literal('items-changed'),
  itemIds: z.array(z.string().min(1)).min(1),
});

// How the Markdown copy of the Daily Notes stands changed (markdown-copy-messages.ts): Settings shows it.
const markdownCopyChanged = z.object({ type: z.literal('markdown-copy-status'), status: markdownCopyStatus });

export const coreMessage = z.discriminatedUnion('type', [
  heartbeat,
  aresActivity,
  aresStatusChanged,
  dashboardRanked,
  itemsChanged,
  markdownCopyChanged,
]);
export type CoreMessage = z.infer<typeof coreMessage>;

export type CoreMessageParseResult = { ok: true; message: CoreMessage } | { ok: false; error: string };

export function parseCoreMessage(input: unknown): CoreMessageParseResult {
  const result = coreMessage.safeParse(input);
  return result.success ? { ok: true, message: result.data } : { ok: false, error: result.error.message };
}
