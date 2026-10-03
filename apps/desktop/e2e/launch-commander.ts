import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';

// Launches the built app with its own throwaway userData folder, so tests never touch the User's
// real database or secrets, and never collide with a running Commander's single-instance lock.
// Pass the folder from an earlier launch to start Commander again on the same data.
export async function launchCommander(options: { userDataDir?: string; env?: Record<string, string> } = {}) {
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'commander-e2e-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    env: options.env ? { ...(process.env as Record<string, string>), ...options.env } : undefined,
  });
  return { app, userDataDir };
}
