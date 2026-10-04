import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ElectronApplication, _electron as electron } from '@playwright/test';

// Launches the built app with its own throwaway userData folder (--user-data-dir), so tests never
// touch the User's real database or secrets. Commander holds a single-instance lock per folder,
// so tests never collide with each other, with runs in other checkouts, or with a running
// Commander; and an instance on a custom folder keeps its commander-show pid file inside it, so
// tests never signal the real one. Pass the folder from an earlier launch to start Commander
// again on the same data. The tests' input never reaches the system, so Commander is told the User
// is at the machine (COMMANDER_TEST_PRESENCE) rather than reading the machine's real idle time.
export type LaunchedCommander = {
  app: ElectronApplication;
  userDataDir: string;
  // The Electron arguments used, for launching a second instance on the same folder.
  args: string[];
  // Quits Commander (app.quit(), like the tray's Quit) and deletes the folder.
  close: () => Promise<void>;
};

export async function launchCommander(
  options: { userDataDir?: string; args?: string[]; env?: Record<string, string> } = {},
): Promise<LaunchedCommander> {
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'commander-e2e-'));
  const args = ['.', `--user-data-dir=${userDataDir}`, ...(options.args ?? [])];
  const app = await electron.launch({
    args,
    env: { ...(process.env as Record<string, string>), COMMANDER_TEST_PRESENCE: 'here', ...options.env },
  });
  return {
    app,
    userDataDir,
    args,
    close: async () => {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}
