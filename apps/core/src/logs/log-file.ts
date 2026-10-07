// Commander's log (#207): what happened, in plain lines, for the User to read and to attach to an
// issue (Settings → Diagnostics → Export diagnostics). The main process and the Core each write their
// own file in the logs folder of Commander's data folder (`main.log`, `core.log`), so neither waits on
// the other or races it to rotate. A file past MAX_LOG_BYTES is rotated (`core.log` → `core.1.log`, …,
// keeping KEPT_FILES), and files untouched for KEEP_LOGS_MS are deleted when the log opens or rotates.
//
// Lines say what happened (sync runs, failures, Core restarts, migrations, snapshots, model call
// errors) and never carry tokens, keys, email text or Item content: callers write ids, counts and
// reasons, never what an Item says, and every line is blanked before it is written. Anything shaped
// like a credential becomes [removed] (safety/credentials.ts), and in the Core a line holding one of
// the tokens or keys it was handed is left out whole (safety/known-secrets.ts).
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { blankCredentials } from '../safety/credentials';
import type { KnownSecrets } from '../safety/known-secrets';

/** The logs folder's name in Commander's data folder. Wipe (#204) deletes it with everything else. */
export const LOGS_FOLDER = 'logs';
/** The logs folder, in Commander's data folder (Electron's userData; the Core's --data-dir). */
export const logsDir = (dataDir: string) => join(dataDir, LOGS_FOLDER);

// One file is rotated past this size.
export const MAX_LOG_BYTES = 1024 * 1024;
// Rotated files kept besides the one being written, per process.
export const KEPT_FILES = 3;
// Files not written to for this long are deleted when the log opens or rotates.
export const KEEP_LOGS_MS = 7 * 24 * 60 * 60 * 1000;
// A longer line is cut short: a line says what happened, it never needs to hold a document.
export const MAX_LINE_CHARS = 1000;

export type LogProcess = 'main' | 'core';
export type LogLevel = 'info' | 'warn' | 'error';

// What a line holding a remembered token or key is replaced with.
export const LEFT_OUT = '[a line holding one of your tokens or keys was left out]';

export type Log = {
  info(area: string, message: string): void;
  warn(area: string, message: string): void;
  error(area: string, message: string): void;
  // console.warn and console.error write to the log too (still printing as before), so the warnings
  // every part of Commander already gives land in it. Returns a function that puts them back.
  captureConsole(): () => void;
};

// The User's home folder, written as ~ (paths in errors and stacks would otherwise carry their name).
const HOME = homedir();
export const withoutHome = (text: string, home = HOME): string =>
  home.length > 1 ? text.split(home).join('~') : text;

/**
 * A message made safe to log: credential-shaped text blanked, the home folder written as ~, one line,
 * cut to MAX_LINE_CHARS, and left out whole when it holds a token or key the Core knows.
 */
export function blankLogText(text: string, secrets?: Pick<KnownSecrets, 'foundIn'>): string {
  if (secrets?.foundIn(text)) return LEFT_OUT;
  const line = withoutHome(blankCredentials(text))
    .replace(/\s*[\r\n]+\s*/g, ' ⏎ ')
    .trim();
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
}

/** One line of the log: "2026-10-06T14:02:03.123Z WARN  core   sync  gmail sync of … did not finish". */
export function logLine(
  at: number,
  process: LogProcess,
  level: LogLevel,
  area: string,
  message: string,
  secrets?: Pick<KnownSecrets, 'foundIn'>,
): string {
  const safeArea = area.replace(/[^\w-]/g, '').slice(0, 12) || '-';
  return `${new Date(at).toISOString()} ${level.toUpperCase().padEnd(5)} ${process.padEnd(4)} ${safeArea.padEnd(8)} ${blankLogText(message, secrets)}`;
}

// What leads a log line: its time, level, process and area (logLine).
const LINE_HEAD = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z [A-Z]+ +[a-z]+ +[\w-]+ +/;

/** A log line, or any line, left out for holding a token or key: its time and source kept, if a log line's. */
export const leftOut = (line: string): string => `${LINE_HEAD.exec(line)?.[0] ?? ''}${LEFT_OUT}`;

/** A process's files in the logs folder, newest first: `core.log`, `core.1.log`, `core.2.log`, … */
export function logFiles(dir: string, process: LogProcess): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const pattern = new RegExp(`^${process}(?:\\.(\\d+))?\\.log$`);
  return names
    .map((name) => ({ name, index: pattern.exec(name) }))
    .filter((each): each is { name: string; index: RegExpExecArray } => each.index !== null)
    .sort((a, b) => Number(a.index[1] ?? 0) - Number(b.index[1] ?? 0))
    .map((each) => join(dir, each.name));
}

/**
 * Every line in the logs folder, from both processes, oldest first (lines sort by their timestamps,
 * which lead each line). At most `limit` of the newest.
 */
export function readLogs(
  dir: string,
  { limit = Number.POSITIVE_INFINITY }: { limit?: number } = {},
): string[] {
  const lines: string[] = [];
  for (const process of ['main', 'core'] as const) {
    for (const file of logFiles(dir, process).reverse()) {
      try {
        for (const line of readFileSync(file, 'utf8').split('\n')) if (line) lines.push(line);
      } catch {
        // Rotated or deleted meanwhile.
      }
    }
  }
  // Stable, so each process's lines keep their order within a millisecond.
  lines.sort((a, b) => (a.slice(0, 24) < b.slice(0, 24) ? -1 : a.slice(0, 24) > b.slice(0, 24) ? 1 : 0));
  return Number.isFinite(limit) ? lines.slice(-limit) : lines;
}

export function createLog({
  dir,
  process,
  maxBytes = MAX_LOG_BYTES,
  keptFiles = KEPT_FILES,
  keepMs = KEEP_LOGS_MS,
  now = Date.now,
  secrets,
  echo = true,
}: {
  dir: string;
  process: LogProcess;
  maxBytes?: number;
  keptFiles?: number;
  keepMs?: number;
  now?: () => number;
  // The tokens and keys the Core holds: a line holding one is left out.
  secrets?: Pick<KnownSecrets, 'foundIn'>;
  // Whether captured console lines still print (off in tests).
  echo?: boolean;
}): Log {
  const file = join(dir, `${process}.log`);
  const rotated = (index: number) => join(dir, `${process}.${index}.log`);
  let size = 0;

  // Files untouched for too long go; the live one too (a Commander not run for weeks starts afresh).
  function tidy() {
    for (const path of logFiles(dir, process)) {
      try {
        if (now() - statSync(path).mtimeMs > keepMs) rmSync(path, { force: true });
      } catch {
        // Gone meanwhile.
      }
    }
  }

  function rotate() {
    rmSync(rotated(keptFiles), { force: true });
    for (let index = keptFiles - 1; index >= 1; index--) {
      try {
        renameSync(rotated(index), rotated(index + 1));
      } catch {
        // No file at that place yet.
      }
    }
    if (keptFiles >= 1) renameSync(file, rotated(1));
    else rmSync(file, { force: true });
    size = 0;
    // A Commander left running for weeks: old rotated files go now, not only at the next start.
    tidy();
  }

  function open() {
    try {
      mkdirSync(dir, { recursive: true });
      tidy();
      size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    } catch {
      size = 0;
    }
  }
  open();

  // Never throws: a log that can't be written must not stop what it was telling about.
  function write(level: LogLevel, area: string, message: string) {
    const line = `${logLine(now(), process, level, area, message, secrets)}\n`;
    const bytes = Buffer.byteLength(line);
    try {
      if (size > 0 && size + bytes > maxBytes) rotate();
      appendFileSync(file, line);
      size += bytes;
    } catch {
      // The folder went (Wipe, #204): make it again, and try once more.
      try {
        open();
        appendFileSync(file, line);
        size += bytes;
      } catch {
        // Nowhere to write: the line is lost, nothing else is.
      }
    }
  }

  return {
    info: (area, message) => write('info', area, message),
    warn: (area, message) => write('warn', area, message),
    error: (area, message) => write('error', area, message),
    captureConsole() {
      const { warn, error } = console;
      console.warn = (...args: unknown[]) => {
        write('warn', 'console', format(...args));
        if (echo) warn.apply(console, args);
      };
      console.error = (...args: unknown[]) => {
        write('error', 'console', format(...args));
        if (echo) error.apply(console, args);
      };
      return () => {
        console.warn = warn;
        console.error = error;
      };
    },
  };
}
