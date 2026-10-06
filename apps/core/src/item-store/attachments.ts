/*
  Pasted images: files in `attachments/` next to the database, each named by the SHA-256 of its
  bytes (so the same image pasted twice is one file, and a file never changes once written).

  - Only PNG, JPEG, GIF and WebP, told apart by their first bytes (never by what the window says),
    up to 20 MB.
  - The daily snapshot covers them: each image a kept snapshot's Blocks use is copied (hard-linked
    where the disk allows) into `snapshots/attachments/`, so a snapshot and that folder restore together.
  - Deleting an image Block leaves its file, so undo brings the image back. A file goes only once no
    live Block and no kept snapshot uses it, and it was pasted more than a day ago (so an image whose
    Block is still being saved is never taken).
*/
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type AttachmentExtension,
  attachmentMaxBytes,
  attachmentsIn,
  isAttachmentName,
} from '@commander/domain';
import Database from 'better-sqlite3';

/** How long an image no Block uses is kept after it was pasted. */
export const unusedAttachmentGraceMs = 24 * 60 * 60 * 1000;

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  bytes.length >= at + prefix.length && prefix.every((byte, i) => bytes[at + i] === byte);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** What kind of image these bytes are, by their signature, or null when they're none we take. */
export function imageTypeOf(bytes: Uint8Array): AttachmentExtension | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'webp';
  return null;
}

/** The attachments the live Blocks of a database use. */
export function attachmentsUsedIn(sqlite: Database.Database): Set<string> {
  const used = new Set<string>();
  // A database from before Daily Notes has no Blocks.
  const hasBlocks = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'block_details'")
    .get();
  if (!hasBlocks) return used;
  const rows = sqlite
    .prepare(
      `SELECT b.text AS text FROM block_details b JOIN items i ON i.id = b.item_id
       WHERE i.deleted_at IS NULL AND b.text LIKE '%attachments/%'`,
    )
    .all() as { text: string }[];
  for (const { text } of rows) for (const name of attachmentsIn(text)) used.add(name);
  return used;
}

/** The attachments the live Blocks of a database file use. */
export function attachmentsUsedInFile(path: string): Set<string> {
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return attachmentsUsedIn(sqlite);
  } finally {
    sqlite.close();
  }
}

// Only files Commander named; anything else in the folders is left alone.
const namesIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter(isAttachmentName) : []);

export interface AttachmentFolderOptions {
  /** The live folder, next to the database. */
  dir: string;
  now: () => number;
  /** Makes the error for a refused image. */
  invalid: (message: string) => Error;
}

export function attachmentFolder({ dir, now, invalid }: AttachmentFolderOptions) {
  return {
    /** Saves an image and returns its file name. The same image again is the same file. */
    save(bytes: Uint8Array): { name: string } {
      if (bytes.byteLength > attachmentMaxBytes) throw invalid('Images can be up to 20 MB.');
      const type = imageTypeOf(bytes);
      if (!type) throw invalid('Only PNG, JPEG, GIF or WebP images can be pasted.');
      const name = `${createHash('sha256').update(bytes).digest('hex')}.${type}`;
      const path = join(dir, name);
      mkdirSync(dir, { recursive: true });
      if (!existsSync(path)) {
        // Written aside then renamed, so a crash never leaves half an image under its real name.
        const partial = `${path}.partial`;
        writeFileSync(partial, bytes);
        renameSync(partial, path);
      }
      // Pasting it (again) starts its day of grace.
      const at = now() / 1000;
      utimesSync(path, at, at);
      return { name };
    },

    /**
     * After a daily snapshot: copies what the kept snapshots use next to them, and lets go of
     * images nothing needs any more. Does nothing if a snapshot can't be read.
     */
    afterSnapshot(sqlite: Database.Database, snapshots: string[], snapshotDir: string) {
      const neededBySnapshots = new Set<string>();
      try {
        for (const path of snapshots)
          for (const name of attachmentsUsedInFile(path)) neededBySnapshots.add(name);
      } catch {
        return;
      }

      const copies = join(snapshotDir, 'attachments');
      for (const name of neededBySnapshots) {
        const live = join(dir, name);
        const copy = join(copies, name);
        if (existsSync(copy) || !existsSync(live)) continue;
        mkdirSync(copies, { recursive: true });
        try {
          linkSync(live, copy);
        } catch {
          copyFileSync(live, copy);
        }
      }
      for (const name of namesIn(copies)) {
        if (!neededBySnapshots.has(name)) rmSync(join(copies, name), { force: true });
      }

      const inUse = attachmentsUsedIn(sqlite);
      const pastedBefore = now() - unusedAttachmentGraceMs;
      for (const name of namesIn(dir)) {
        if (inUse.has(name) || neededBySnapshots.has(name)) continue;
        const path = join(dir, name);
        const stat = lstatSync(path);
        if (stat.isFile() && stat.mtimeMs <= pastedBefore) rmSync(path, { force: true });
      }
    },
  };
}

export type AttachmentFolder = ReturnType<typeof attachmentFolder>;
