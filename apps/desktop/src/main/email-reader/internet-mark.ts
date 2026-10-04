// Marks an attachment as having come from the internet (#134), as browsers mark downloads, so the
// system and the apps that open it treat it with care (Office's Protected View, Gatekeeper, Windows
// SmartScreen): on Windows the Mark of the Web (a Zone.Identifier stream, zone 3: the internet), on
// macOS the quarantine attribute. Linux has no such mark that desktops honour; there, Commander's own
// rule (only viewer formats open, everything else is only saved) is what stands.
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

export type MarkOptions = {
  platform?: NodeJS.Platform;
  now?: () => number;
  run?: (command: string, args: string[]) => Promise<unknown>;
  write?: (path: string, data: string) => Promise<void>;
};

/** Marks the file; rejects if the mark couldn't be written where the system has one. */
export async function markFromInternet(path: string, options: MarkOptions = {}): Promise<void> {
  const {
    platform = process.platform,
    now = Date.now,
    run = (command, args) => promisify(execFile)(command, args),
    write = (target, data) => writeFile(target, data),
  } = options;
  if (platform === 'win32') {
    await write(`${path}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
  } else if (platform === 'darwin') {
    const seconds = Math.floor(now() / 1000).toString(16);
    await run('xattr', ['-w', 'com.apple.quarantine', `0081;${seconds};Commander;`, path]);
  }
}
