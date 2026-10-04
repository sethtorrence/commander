import { z } from 'zod';

/*
  Settings → Notes → Markdown copy folder (#53). The Core writes a read-only Markdown copy of every
  Daily Note into a folder the User picks with the system folder picker. The window can only ask the
  main process to show that picker (or to turn the copy off): it never names a folder itself, so it
  can't make Commander write anywhere it likes. The main process checks the folder chosen and hands it
  to the Core, which checks it again, keeps it, and does the writing.
*/

const requestId = z.number().int().positive();
const timestamp = z.number().int().nonnegative();

// How the copy stands. 'off': no folder chosen. 'writing': catching up after the folder was chosen
// or changed. 'ok': every change so far is written. 'failed': the last write failed (`problem` says
// why, for the User); Commander keeps trying, and editing is never held up.
export const markdownCopyStatus = z.object({
  folder: z.string().min(1).nullable(),
  state: z.enum(['off', 'writing', 'ok', 'failed']),
  problem: z.string().nullable(),
  lastWrittenAt: timestamp.nullable(),
});
export type MarkdownCopyStatus = z.infer<typeof markdownCopyStatus>;

// The window → main process.
export const markdownCopyRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('status') }),
  // Shows the system folder picker; the folder chosen (if any) becomes the copy's folder.
  z.object({ op: z.literal('choose-folder') }),
  z.object({ op: z.literal('turn-off') }),
]);
export type MarkdownCopyRequest = z.input<typeof markdownCopyRequest>;

// A refused folder (or a Core that didn't answer) is `ok: false`, with the reason for the User.
export type MarkdownCopyResponse =
  | { ok: true; status: MarkdownCopyStatus }
  | { ok: false; error: string; status: MarkdownCopyStatus | null };

// Main process → Core. `folder` is an absolute path the main process has checked; null turns it off.
export const coreMarkdownCopyRequest = z.object({
  type: z.literal('markdown-copy-request'),
  id: requestId,
  request: z.discriminatedUnion('op', [
    z.object({ op: z.literal('status') }),
    z.object({ op: z.literal('set-folder'), folder: z.string().min(1).nullable() }),
  ]),
});
export type CoreMarkdownCopyRequest = z.input<typeof coreMarkdownCopyRequest>;

// Core → main process.
export const coreMarkdownCopyReply = z.object({
  type: z.literal('markdown-copy-reply'),
  id: requestId,
  response: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), status: markdownCopyStatus }),
    z.object({ ok: z.literal(false), error: z.string(), status: markdownCopyStatus }),
  ]),
});
export type CoreMarkdownCopyReply = z.infer<typeof coreMarkdownCopyReply>;
