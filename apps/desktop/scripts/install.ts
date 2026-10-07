// Installing Commander for the author (#208): the packaged app (dist/linux-unpacked, from `pnpm package`)
// goes under his home, beside a launcher, `commander-show` and Start at login, replacing a running
// Commander. install-local.ts runs it; see the README, "Installing Commander".
//
// Run by Node directly (no build step), so this and what it imports name their files with extensions.
import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { autostartEntry, autostartPath, execValue, launchAtLoginCommand } from '../src/main/autostart.ts';
import { pidFilePath, processStartTime } from '../src/main/pid-file.ts';

type Env = Record<string, string | undefined>;

export type InstallTarget = {
  // The app's folder, replaced as a whole on every install.
  appDir: string;
  executable: string;
  // commander-show, on the PATH.
  helper: string;
  // The launcher: commander.desktop, the name Hyprland matches the window class "commander" to.
  launcher: string;
  // Start at login's XDG autostart entry, as the app writes it (autostart.ts).
  autostart: string;
  // Where a running Commander leaves its pid (pid-file.ts), as commander-show finds it.
  pidFile: string;
};

// Everything goes under ~/.local unless COMMANDER_INSTALL_PREFIX says otherwise (the tests point it,
// XDG_CONFIG_HOME and COMMANDER_PID_FILE at throwaway folders).
export function installTarget({ env, home, uid }: { env: Env; home: string; uid: number }): InstallTarget {
  const prefix = env.COMMANDER_INSTALL_PREFIX || join(home, '.local');
  const appDir = join(prefix, 'opt', 'commander');
  return {
    appDir,
    executable: join(appDir, 'commander'),
    helper: join(prefix, 'bin', 'commander-show'),
    launcher: join(prefix, 'share', 'applications', 'commander.desktop'),
    autostart: autostartPath(env, home),
    pidFile: pidFilePath({ env, uid }),
  };
}

// The launcher. The launch switches (Wayland, the keyring) are applied by the app itself
// (launch-switches.ts), so the command is just the app. StartupWMClass ties the window to this entry.
export function launcherEntry(executable: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Commander',
    'Comment=A personal command center that runs entirely on your own machine',
    `Exec=${execValue([executable])}`,
    'Terminal=false',
    'Categories=Office;',
    'StartupWMClass=commander',
    '',
  ].join('\n');
}

export type Installed = { startAtLogin: 'pointed at the installed app' | 'off' };

// Copies the app in beside the old one, then swaps them, so a failed copy leaves the old one working.
export function installFiles({
  packaged,
  helperSource,
  target,
}: {
  packaged: string;
  helperSource: string;
  target: InstallTarget;
}): Installed {
  if (!existsSync(join(packaged, 'commander'))) {
    throw new Error(`No packaged Commander in ${packaged}: run \`pnpm package\` first.`);
  }
  const staging = `${target.appDir}.new`;
  const previous = `${target.appDir}.old`;
  rmSync(staging, { recursive: true, force: true });
  rmSync(previous, { recursive: true, force: true });
  mkdirSync(dirname(target.appDir), { recursive: true });
  cpSync(packaged, staging, { recursive: true, verbatimSymlinks: true });
  if (existsSync(target.appDir)) renameSync(target.appDir, previous);
  renameSync(staging, target.appDir);
  rmSync(previous, { recursive: true, force: true });

  // Removed first, never written through: the README once had it linked to the checkout's copy.
  mkdirSync(dirname(target.helper), { recursive: true });
  rmSync(target.helper, { force: true });
  copyFileSync(helperSource, target.helper);
  chmodSync(target.helper, 0o755);

  mkdirSync(dirname(target.launcher), { recursive: true });
  writeFileSync(target.launcher, launcherEntry(target.executable));

  // The entry existing is the setting: on stays on, now starting the installed app; off stays off.
  if (!existsSync(target.autostart)) return { startAtLogin: 'off' };
  const command = launchAtLoginCommand({ execPath: target.executable, appPath: '', isPackaged: true });
  writeFileSync(target.autostart, autostartEntry(command));
  return { startAtLogin: 'pointed at the installed app' };
}

export type RunningCommander = { pid: number; startTime: string; executable: string | null };

const startTimeOf = (pid: number) => {
  try {
    return processStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
};

// The Commander the pid file names, if that process is still the one that wrote it.
export function findRunning(pidFile: string): RunningCommander | null {
  let contents: string;
  try {
    contents = readFileSync(pidFile, 'utf8');
  } catch {
    return null;
  }
  const [pidText, startTime] = contents.trim().split(' ');
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0 || !startTime || startTimeOf(pid) !== startTime) return null;
  let executable: string | null = null;
  try {
    executable = readlinkSync(`/proc/${pid}/exe`);
  } catch {
    // Not ours to read: it still is Commander.
  }
  return { pid, startTime, executable };
}

export const stillRunning = (running: RunningCommander) => startTimeOf(running.pid) === running.startTime;

// What the installed app starts with: this environment without what pnpm and Node add to it, from the
// home folder rather than the checkout, in a session of its own so it outlives the terminal.
export function appEnvironment(env: Env): Env {
  const clean: Env = {};
  for (const [name, value] of Object.entries(env)) {
    if (/^(npm_|PNPM_|pnpm_)/.test(name) || name === 'NODE_OPTIONS' || name === 'INIT_CWD') continue;
    if (name.startsWith('ELECTRON_')) continue;
    clean[name] = value;
  }
  if (env.PATH) {
    clean.PATH = env.PATH.split(delimiter)
      .filter((dir) => !dir.includes('/node_modules/.bin'))
      .join(delimiter);
  }
  return clean;
}

export function startDetached(executable: string, env: Env, home: string): void {
  spawn(executable, [], { cwd: home, env: appEnvironment(env), detached: true, stdio: 'ignore' }).unref();
}

// The tray's Quit waits up to 2 s for the window to save and 15 s for held sends, then 3 s for the Core
// (background.ts, lifecycle.ts): past this, something else is keeping it (a question on screen).
export const QUIT_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 15_000;

export type Outcome = 'installed' | 'replaced' | 'still running';

export async function installReplacing(options: {
  target: InstallTarget;
  install: () => Installed;
  start: () => void;
  log: (line: string) => void;
  askToQuit?: (pid: number) => void;
  quitTimeoutMs?: number;
  startTimeoutMs?: number;
  pollMs?: number;
}): Promise<Outcome> {
  const { target, install, start, log, pollMs = 100 } = options;
  const askToQuit = options.askToQuit ?? ((pid) => process.kill(pid, 'SIGTERM'));
  const sleep = () => new Promise((resolve) => setTimeout(resolve, pollMs));
  const until = async (done: () => boolean, timeoutMs: number) => {
    const end = Date.now() + timeoutMs;
    while (!done()) {
      if (Date.now() >= end) return false;
      await sleep();
    }
    return true;
  };

  const running = findRunning(target.pidFile);
  if (running) {
    const which =
      running.executable === target.executable ? 'the installed Commander' : 'the running Commander';
    log(
      `Asking ${which} (pid ${running.pid}) to quit. It saves what it holds and sends held messages first.`,
    );
    askToQuit(running.pid);
    if (!(await until(() => !stillRunning(running), options.quitTimeoutMs ?? QUIT_TIMEOUT_MS))) {
      log(
        'Commander is still running, so nothing was installed. It may be asking you something (a full disk); answer it or choose Quit Commander in the tray, then run this again.',
      );
      return 'still running';
    }
    log('Commander quit.');
  }

  const installed = install();
  log(`Installed Commander in ${target.appDir}`);
  log(`  launcher: ${target.launcher}`);
  log(`  commander-show: ${target.helper}`);
  log(
    installed.startAtLogin === 'off'
      ? '  Start at login: off (turn it on in Settings → General)'
      : `  Start at login: on, ${installed.startAtLogin} (${target.autostart})`,
  );

  if (!running) {
    log('Commander was not running: start it from your launcher.');
    return 'installed';
  }
  start();
  const started = await until(
    () => findRunning(target.pidFile) !== null,
    options.startTimeoutMs ?? START_TIMEOUT_MS,
  );
  log(started ? 'Started Commander again.' : 'Started Commander again, but it has not come up yet.');
  return 'replaced';
}
