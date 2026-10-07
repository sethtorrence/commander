// `pnpm install:local`, after `pnpm package`: installs the packaged Commander under the author's home,
// replacing (and restarting) a running one. See install.ts and the README, "Installing Commander".
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { installFiles, installReplacing, installTarget, startDetached } from './install.ts';

if (process.platform !== 'linux') {
  console.error('Installing Commander this way is for Linux.');
  process.exit(1);
}

const home = homedir();
const target = installTarget({ env: process.env, home, uid: process.getuid?.() ?? 0 });
const outcome = await installReplacing({
  target,
  install: () =>
    installFiles({
      packaged: resolve(import.meta.dirname, '../dist/linux-unpacked'),
      helperSource: resolve(import.meta.dirname, '../bin/commander-show'),
      target,
    }),
  start: () => startDetached(target.executable, process.env, home),
  log: (line) => console.log(line),
});
if (outcome === 'still running') process.exitCode = 1;
