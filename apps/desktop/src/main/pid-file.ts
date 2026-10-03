import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The pid file is how `commander-show` (apps/desktop/bin/commander-show) finds the running app
// to send it SIGUSR1. The helper computes the same path, so keep the two in step.
// It holds "<pid> <start time>": the helper checks the start time before signalling, so a
// stale file whose pid now belongs to another process never gets that process killed.

export type PidRecord = { pid: number; startTime: string };

type Env = Partial<Record<'COMMANDER_PID_FILE' | 'XDG_RUNTIME_DIR' | 'TMPDIR', string>>;

// An instance on a throwaway profile (--user-data-dir, as the end-to-end tests use) keeps its
// pid file in that profile, so it never takes over the real Commander's commander-show.
export function pidFilePath(options: { env: Env; uid: number; customUserDataDir?: string }): string {
  const { env, uid, customUserDataDir } = options;
  if (env.COMMANDER_PID_FILE) return env.COMMANDER_PID_FILE;
  if (customUserDataDir) return join(customUserDataDir, 'commander.pid');
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, 'commander.pid');
  return join(env.TMPDIR || '/tmp', `commander-${uid}.pid`);
}

// Field 22 of /proc/<pid>/stat, in clock ticks since boot. Fields are counted after the
// command name, which is parenthesised and may contain anything, so split after the last ")".
export function processStartTime(stat: string): string | null {
  const end = stat.lastIndexOf(')');
  if (end < 0) return null;
  const fields = stat.slice(end + 2).split(' ');
  return fields[19] ?? null;
}

export function ownPidRecord(): PidRecord | null {
  try {
    const startTime = processStartTime(readFileSync('/proc/self/stat', 'utf8'));
    return startTime ? { pid: process.pid, startTime } : null;
  } catch {
    return null; // No procfs (macOS, Windows): there is no commander-show there either.
  }
}

const contents = (record: PidRecord) => `${record.pid} ${record.startTime}\n`;

export function writePidFile(path: string, record: PidRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents(record), { mode: 0o600 });
}

export function removePidFile(path: string, record: PidRecord): void {
  try {
    if (readFileSync(path, 'utf8') === contents(record)) rmSync(path);
  } catch {
    // Already gone.
  }
}
