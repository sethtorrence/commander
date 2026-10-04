import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { SignInError } from '../oauth/sign-in-error';

// GitHub's own command-line tool, gh, when the User has it signed in: "Use my gh sign-in" runs
// `gh auth token` once and stores what it prints as the Account's token (like a pasted one). The
// token goes straight to the keyring; nothing gh prints is shown or logged.

export type GhCli = {
  // Whether gh is on the PATH.
  readonly installed: boolean;
  // The token gh holds for github.com. Rejects with a SignInError.
  token(): Promise<string>;
};

const TIMEOUT_MS = 10_000;

function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    for (const file of names) {
      if (!dir) continue;
      try {
        accessSync(join(dir, file), constants.X_OK);
        return true;
      } catch {
        // Not here.
      }
    }
  }
  return false;
}

export function ghCli(env: NodeJS.ProcessEnv = process.env): GhCli {
  return {
    installed: onPath('gh', env),
    token: () =>
      new Promise((resolve, reject) => {
        execFile(
          'gh',
          ['auth', 'token', '--hostname', 'github.com'],
          { env, timeout: TIMEOUT_MS, windowsHide: true },
          (error, stdout) => {
            const token = String(stdout).trim();
            if (!error && token) return resolve(token);
            if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
              return reject(
                new SignInError(
                  'not-configured',
                  'GitHub’s gh command isn’t installed, so there is no gh sign-in to use. Paste a token instead.',
                ),
              );
            }
            reject(
              new SignInError(
                'invalid-credential',
                'gh isn’t signed in to GitHub. Run gh auth login in a terminal, then try again.',
              ),
            );
          },
        );
      }),
  };
}
