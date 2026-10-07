/*
  Export everything (#202): everything of the User's that Commander holds, written into a folder of
  its own ("Commander export 2026-10-06 14.32") inside the folder the User chose:

  - commander.db: a consistent, checked copy of the database (as a snapshot is made);
  - Daily Notes/: each day as Markdown (the Markdown copy's format), with its images;
  - attachments/: the pasted images, as the database names them;
  - email-parts/ and compose-files/: cached email attachments and inline images, and the files
    attached to messages not yet sent;
  - README.txt: what each part is.

  In the Core's limited state (#203: the database couldn't be updated) there is no Item store: the
  database is copied from its file as it is, and Daily Notes/ is left out (the notes are all in the
  database copy), as the README then says.

  It is laid out like Commander's own data folder, so the database finds its images. It never reads
  anything else in the data folder: secrets.json, the keyring and Electron's own files are never part
  of it, so no secret, token or key can be. Written under a hidden name and renamed once complete; a
  cancelled or failed export removes its own folder and nothing else.
*/
import type { Dirent } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { type ExportStep, isAttachmentName } from '@commander/domain';
import Database from 'better-sqlite3';
import type { ItemStore } from '../item-store';
import { copyDatabase } from '../item-store/snapshots';
import { dailyNoteFiles } from '../markdown-copy';

export type ExportOptions = {
  // Null in the Core's limited state (#203).
  store: ItemStore | null;
  dataDir: string;
  attachmentsDir: string;
  // The folder the User chose (checked by the main process): the export goes in a new folder in it.
  into: string;
  signal: AbortSignal;
  onProgress(step: ExportStep, done: number, total: number): void;
  // Hears the folder being written, so a Core stopping mid-export can remove it (index.ts).
  onWorking?: (path: string) => void;
  now?: () => number;
};

// Cached files the export copies, by their folder in the data folder.
export const CACHED_FOLDERS = ['email-parts', 'compose-files'] as const;

export const EXPORT_README = `Commander export
================

Everything Commander held on this computer when it was exported. Nothing in here is a secret:
sign-ins, tokens and API keys stay in your system keyring and are never exported.

commander.db
  The database: every Item (emails, events, Linear issues, GitHub work, Teams Chats, Todos, Daily
  Notes and their Blocks), Projects, Links, People, Rules, the activity log and Ares's Memory. An
  SQLite file, readable by any SQLite tool. Laid out like Commander's own data folder, so Commander
  can open it with the folders beside it.

Daily Notes/
  Each Daily Note as YYYY-MM-DD.md, in the same format as the Markdown copy, with the images the
  notes show in Daily Notes/attachments/.

attachments/
  The images pasted into Daily Notes, each named by the SHA-256 of its contents, as the database
  refers to them.

email-parts/
  Email attachments and inline images Commander had downloaded, one folder per Account (named by a
  hash of the Account), then per message part.

compose-files/
  Files attached to messages that had not been sent yet.
`;

// Added to the README of an export made while Commander couldn't update its database.
export const EXPORT_README_LIMITED = `
This export was made while Commander couldn't update its database, so there is no Daily Notes/
folder: the notes are all in commander.db, as the previous version of Commander left them.
`;

// A consistent, checked copy of the database file as it is, without the Item store (#203).
function copyDatabaseFile(dataDir: string, path: string) {
  const sqlite = new Database(join(dataDir, 'commander.db'), { readonly: true, fileMustExist: true });
  try {
    copyDatabase(sqlite, path);
  } finally {
    sqlite.close();
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
const folderName = (at: number) => {
  const date = new Date(at);
  return `Commander export ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}`;
};

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** A folder name not yet taken in `into`: "Commander export …", then "… (2)". */
async function freeName(into: string, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} (${n})`;
    if (!(await exists(join(into, name))) && !(await exists(join(into, `.${name}.partial`)))) return name;
  }
}

/** Every file under a folder (none when it doesn't exist), as paths relative to it. */
async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (at: string) => {
    let entries: Dirent[];
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      // Only files and folders: links are never followed out of Commander's folders.
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(relative(dir, path));
    }
  };
  await walk(dir);
  return found.sort();
}

export class ExportCancelled extends Error {
  override name = 'ExportCancelled';
}

/** Writes the export; resolves with its folder. Throws ExportCancelled once cancelled. */
export async function exportEverything({
  store,
  dataDir,
  attachmentsDir,
  into,
  signal,
  onProgress,
  onWorking,
  now = Date.now,
}: ExportOptions): Promise<string> {
  const name = await freeName(into, folderName(now()));
  const work = join(into, `.${name}.partial`);
  const stopIfCancelled = () => {
    if (signal.aborted) throw new ExportCancelled('The export was cancelled.');
  };
  await mkdir(work);
  onWorking?.(work);
  try {
    // The database, as one step: a consistent copy, checked.
    onProgress('database', 0, 1);
    stopIfCancelled();
    if (store) store.copyDatabaseTo(join(work, 'commander.db'));
    else copyDatabaseFile(dataDir, join(work, 'commander.db'));
    onProgress('database', 1, 1);

    // Each Daily Note as Markdown, with its images.
    stopIfCancelled();
    if (store) {
      const notes = join(work, 'Daily Notes');
      await mkdir(notes);
      const files = dailyNoteFiles(store, attachmentsDir);
      const days = files.allDays();
      const projects = files.projectsLookup();
      onProgress('daily-notes', 0, days.length);
      for (const [index, { day, id }] of days.entries()) {
        stopIfCancelled();
        await files.writeDay(notes, day, id, projects);
        onProgress('daily-notes', index + 1, days.length);
      }
    } else onProgress('daily-notes', 0, 0);

    // The pasted images (only files Commander named).
    const images = (await readdir(attachmentsDir).catch(() => [] as string[]))
      .filter(isAttachmentName)
      .sort();
    onProgress('images', 0, images.length);
    if (images.length) await mkdir(join(work, 'attachments'));
    for (const [index, image] of images.entries()) {
      stopIfCancelled();
      await copyFile(join(attachmentsDir, image), join(work, 'attachments', image));
      onProgress('images', index + 1, images.length);
    }

    // Cached email attachments, and the files waiting to be sent.
    const cached = (
      await Promise.all(
        CACHED_FOLDERS.map(async (folder) =>
          (await filesUnder(join(dataDir, folder))).map((path) => join(folder, path)),
        ),
      )
    ).flat();
    onProgress('attachments', 0, cached.length);
    for (const [index, path] of cached.entries()) {
      stopIfCancelled();
      const to = join(work, path);
      await mkdir(join(to, '..'), { recursive: true });
      await copyFile(join(dataDir, path), to);
      onProgress('attachments', index + 1, cached.length);
    }

    onProgress('readme', 0, 1);
    stopIfCancelled();
    await writeFile(
      join(work, 'README.txt'),
      store ? EXPORT_README : EXPORT_README + EXPORT_README_LIMITED,
      'utf8',
    );
    onProgress('readme', 1, 1);

    const done = join(into, name);
    await rename(work, done);
    return done;
  } catch (error) {
    await rm(work, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
