// Settings → Data → Wipe all Commander data (#204, decision #30), in the main process. Once the User
// has typed the confirmation word:
//
// 1. Where the Markdown copy is written is asked of the Core, if the User ticked deleting it (the
//    window never names a folder).
// 2. Sync and the Core stop for good: the supervisor ends the Core as quitting does, so it is never
//    taken for a crash and never started again.
// 3. Everything Commander keeps in its data folder goes, by name (wipeDataFolder): the database,
//    every snapshot, saved secrets, the Accounts list, cached attachments and pasted images, files
//    waiting to be sent and the downloaded search model. Nothing else in the folder is touched (it
//    is Electron's too), and the folder itself stays.
// 4. The window's own storage goes (its settings in localStorage, its caches).
// 5. The keyring entry that encrypted the saved secrets is deleted, but only for Commander's own data
//    folder: one started on another (--user-data-dir, as every test is) shares that entry with the
//    real Commander, so it is never touched from there.
// 6. If ticked, the Markdown copy's files (wipeMarkdownCopy): only the ones Commander writes there.
// 7. Commander relaunches, as if new; the logs folder goes last, as it quits (wipeLogs), since any
//    line written before then would make it again.
import { existsSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LOGS_FOLDER } from '@commander/core/src/logs/log-file';
import { confirmsWipe, WIPE_WORD, type WipeResponse, wipeRequest } from '@commander/domain';

// What Commander keeps in its data folder: folders, and files by name or by how their names start
// (the database with its write-ahead log and a restore's copies, the restore's marker).
const OWN_FOLDERS = ['snapshots', 'attachments', 'email-parts', 'compose-files', 'models'];
const OWN_FILES = ['secrets.json', 'accounts.json'];
const OWN_PREFIXES = ['commander.db', 'restore-pending.json'];
// Files saved beside secrets.json and accounts.json while they are written.
const OWN_TEMP = /^(?:secrets|accounts)\.json\.[0-9a-f]+\.tmp$/;

const isOwn = (name: string) =>
  OWN_FOLDERS.includes(name) ||
  OWN_FILES.includes(name) ||
  OWN_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
  OWN_TEMP.test(name);

/** Deletes what Commander keeps in its data folder, and nothing else. Returns the names deleted. */
export function wipeDataFolder(userData: string): string[] {
  if (!existsSync(userData)) return [];
  const gone = readdirSync(userData).filter(isOwn).sort();
  for (const name of gone) rmSync(join(userData, name), { recursive: true, force: true });
  return gone;
}

/** Deletes Commander's logs (#207): last of all, as Commander quits after a wipe. */
export function wipeLogs(userData: string): void {
  rmSync(join(userData, LOGS_FOLDER), { recursive: true, force: true });
}

// What the Markdown copy writes (markdown-copy in the Core): a file per day, the images they show,
// and the files written beside them on the way.
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/;
const DAY_TEMP = /^\.\d{4}-\d{2}-\d{2}\.md\.[0-9a-f]+\.tmp$/;
const IMAGE_FILE = /^\.?[0-9a-f]{64}\.[a-z0-9]+(?:\.[0-9a-f]+\.tmp)?$/;

const removeIfEmpty = (dir: string) => {
  try {
    rmdirSync(dir);
  } catch {
    // Something of the User's is still in it.
  }
};

/**
 * Deletes the Markdown copy's files from its folder: only the day files and images Commander wrote,
 * so a copy kept inside an Obsidian vault leaves the vault as it was. The folder goes too once
 * nothing else is in it. Returns how many files went.
 */
export function wipeMarkdownCopy(folder: string): number {
  if (!existsSync(folder)) return 0;
  let count = 0;
  for (const name of readdirSync(folder)) {
    if (!DAY_FILE.test(name) && !DAY_TEMP.test(name)) continue;
    rmSync(join(folder, name), { force: true });
    count += 1;
  }
  const images = join(folder, 'attachments');
  if (existsSync(images)) {
    for (const name of readdirSync(images)) {
      if (!IMAGE_FILE.test(name)) continue;
      rmSync(join(images, name), { force: true });
      count += 1;
    }
    removeIfEmpty(images);
  }
  removeIfEmpty(folder);
  return count;
}

// The pause between the window hearing the wipe was made and Commander quitting to relaunch.
const RELAUNCH_AFTER_MS = 300;

export function createWipeChannel(options: {
  userData: string;
  // Where the Markdown copy is written, as the Core keeps it; null when it is off (or unknown).
  markdownCopyFolder(): Promise<string | null>;
  // Stops sync and the Core for good, resolving once the Core has exited.
  stopCore(): Promise<void>;
  // Clears the window's own storage (localStorage, caches).
  clearWindowStorage(): Promise<void>;
  // Deletes the keyring entry the saved secrets were encrypted with; null where it must not be
  // touched (a data folder other than Commander's own).
  clearKeyring: (() => Promise<void>) | null;
  // Relaunches Commander (app.relaunch, then a clean quit).
  relaunch(): void;
  log?: (message: string) => void;
  relaunchAfterMs?: number;
}) {
  const log = options.log ?? ((message: string) => console.warn(message));
  let wiping = false;

  return {
    // A request from the window.
    async request(raw: unknown): Promise<WipeResponse> {
      const parsed = wipeRequest.safeParse(raw);
      if (!parsed.success) return { ok: false, error: `Rejected wipe request: ${parsed.error.message}` };
      if (!confirmsWipe(parsed.data.confirmation))
        return { ok: false, error: `Type “${WIPE_WORD}” to confirm.` };
      if (wiping) return { ok: false, error: 'Commander is already wiping its data.' };
      wiping = true;
      const folder = parsed.data.markdownCopy ? await options.markdownCopyFolder().catch(() => null) : null;
      await options.stopCore();
      const gone = wipeDataFolder(options.userData);
      log(`Wiped Commander's data: ${gone.join(', ') || 'nothing was there'}`);
      try {
        await options.clearWindowStorage();
      } catch (error) {
        log(`Could not clear the window's storage: ${String(error)}`);
      }
      if (options.clearKeyring) {
        try {
          await options.clearKeyring();
        } catch (error) {
          log(`Could not delete the keyring entry: ${String(error)}`);
        }
      } else {
        log('Left the keyring entry: this Commander runs on a data folder of its own');
      }
      if (folder) log(`Deleted ${wipeMarkdownCopy(folder)} files of the Markdown copy in ${folder}`);
      // After the reply, so the window can say Commander is relaunching.
      setTimeout(() => options.relaunch(), options.relaunchAfterMs ?? RELAUNCH_AFTER_MS);
      return { ok: true, relaunching: true };
    },
  };
}
