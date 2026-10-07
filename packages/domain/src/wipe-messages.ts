import { z } from 'zod';

/*
  Wipe all Commander data (#204, decision #30): Settings → Data, after the User types WIPE_WORD.
  The main process stops sync and the Core (for good: no crash, no restart), deletes everything
  Commander keeps (the database, every snapshot, saved secrets and their keyring entry, cached
  attachments and images, the downloaded search model, Commander's own settings), and relaunches
  as if new. The Markdown copy folder is the User's, so its files go only when they tick it
  (`markdownCopy`, unticked by default); the main process asks the Core where it is, as the window
  never names a folder.
*/

// What the User types to confirm a wipe.
export const WIPE_WORD = 'wipe';
export const confirmsWipe = (typed: string) => typed.trim().toLowerCase() === WIPE_WORD;

// The window → main process.
export const wipeRequest = z.object({
  confirmation: z.string(),
  // Delete the Markdown copy of the Daily Notes too.
  markdownCopy: z.boolean(),
});
export type WipeRequest = z.input<typeof wipeRequest>;

// `relaunching`: the wipe was made, and Commander is about to start again as new.
export type WipeResponse = { ok: true; relaunching: true } | { ok: false; error: string };
