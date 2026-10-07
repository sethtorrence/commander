import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Wipe all Commander data (#204): the keyring entry Electron's safeStorage encrypts the saved secrets
// with. Electron has no call to delete it, so on Linux it goes through the Secret Service with
// libsecret's secret-tool, by the attribute Chromium stores it under (`application`, the app's
// name). Only ever called for Commander's own data folder (see main/index.ts): a Commander started
// on another folder shares this entry with the real one. Elsewhere (macOS, Windows) it is left: the
// secrets it protected are deleted with secrets.json either way.

export type RunCommand = (file: string, args: string[]) => Promise<unknown>;

const run: RunCommand = (file, args) => promisify(execFile)(file, args, { timeout: 10_000 });

export async function clearSafeStorageKey(
  appName: string,
  { platform = process.platform, command = run }: { platform?: NodeJS.Platform; command?: RunCommand } = {},
): Promise<void> {
  if (platform !== 'linux') return;
  await command('secret-tool', ['clear', 'application', appName]);
}
