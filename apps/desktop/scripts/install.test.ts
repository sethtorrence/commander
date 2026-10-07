import { type ChildProcess, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autostartEntry } from '../src/main/autostart.ts';
import {
  appEnvironment,
  findRunning,
  type InstallTarget,
  installFiles,
  installReplacing,
  installTarget,
  launcherEntry,
} from './install.ts';

describe('installTarget', () => {
  it('installs under ~/.local, with Start at login and the pid file where the app keeps them', () => {
    expect(installTarget({ env: { XDG_RUNTIME_DIR: '/run/user/1000' }, home: '/home/u', uid: 1000 })).toEqual(
      {
        appDir: '/home/u/.local/opt/commander',
        executable: '/home/u/.local/opt/commander/commander',
        helper: '/home/u/.local/bin/commander-show',
        launcher: '/home/u/.local/share/applications/commander.desktop',
        autostart: '/home/u/.config/autostart/commander.desktop',
        pidFile: '/run/user/1000/commander.pid',
      },
    );
  });

  it('goes wherever COMMANDER_INSTALL_PREFIX, XDG_CONFIG_HOME and COMMANDER_PID_FILE say', () => {
    const target = installTarget({
      env: {
        COMMANDER_INSTALL_PREFIX: '/tmp/p',
        XDG_CONFIG_HOME: '/tmp/c',
        COMMANDER_PID_FILE: '/tmp/x.pid',
      },
      home: '/home/u',
      uid: 1000,
    });
    expect(target).toMatchObject({
      executable: '/tmp/p/opt/commander/commander',
      helper: '/tmp/p/bin/commander-show',
      launcher: '/tmp/p/share/applications/commander.desktop',
      autostart: '/tmp/c/autostart/commander.desktop',
      pidFile: '/tmp/x.pid',
    });
  });
});

describe('launcherEntry', () => {
  it('starts the installed app, and matches the window class Hyprland binds', () => {
    const entry = launcherEntry('/home/u/.local/opt/commander/commander');
    expect(entry).toMatch(/^\[Desktop Entry\]\n/);
    expect(entry).toContain('\nType=Application\n');
    expect(entry).toContain('\nName=Commander\n');
    expect(entry).toContain('\nExec=/home/u/.local/opt/commander/commander\n');
    expect(entry).toContain('\nStartupWMClass=commander\n');
  });

  it('quotes a path with spaces', () => {
    expect(launcherEntry('/home/my user/.local/opt/commander/commander')).toContain(
      '\nExec="/home/my user/.local/opt/commander/commander"\n',
    );
  });
});

let dir: string;
let target: InstallTarget;
let packaged: string;
let helperSource: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-install-test-'));
  target = installTarget({
    env: {
      COMMANDER_INSTALL_PREFIX: join(dir, 'local'),
      XDG_CONFIG_HOME: join(dir, 'config'),
      COMMANDER_PID_FILE: join(dir, 'commander.pid'),
    },
    home: join(dir, 'home'),
    uid: 1000,
  });
  // A stand-in for dist/linux-unpacked.
  packaged = join(dir, 'linux-unpacked');
  mkdirSync(join(packaged, 'resources/app'), { recursive: true });
  writeFileSync(join(packaged, 'commander'), '#!/bin/sh\n');
  chmodSync(join(packaged, 'commander'), 0o755);
  writeFileSync(join(packaged, 'resources/app/package.json'), '{"version":"2"}');
  helperSource = join(dir, 'commander-show');
  writeFileSync(helperSource, '#!/bin/sh\necho show\n');
  chmodSync(helperSource, 0o644);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;

describe('installFiles', () => {
  it('installs the app, the launcher and commander-show', () => {
    expect(installFiles({ packaged, helperSource, target })).toEqual({ startAtLogin: 'off' });

    expect(mode(target.executable)).toBe(0o755);
    expect(readFileSync(join(target.appDir, 'resources/app/package.json'), 'utf8')).toBe('{"version":"2"}');
    expect(readFileSync(target.helper, 'utf8')).toBe('#!/bin/sh\necho show\n');
    expect(mode(target.helper)).toBe(0o755);
    expect(readFileSync(target.launcher, 'utf8')).toBe(launcherEntry(target.executable));
    // Start at login stays off until the User turns it on.
    expect(existsSync(target.autostart)).toBe(false);
  });

  it('points Start at login at the installed app when it is on', () => {
    mkdirSync(join(dir, 'config/autostart'), { recursive: true });
    // As `pnpm dev` wrote it: Electron with the checkout's folder.
    writeFileSync(
      target.autostart,
      autostartEntry(['/src/node_modules/electron', '/src/apps/desktop', '--hidden']),
    );

    expect(installFiles({ packaged, helperSource, target })).toEqual({
      startAtLogin: 'pointed at the installed app',
    });
    expect(readFileSync(target.autostart, 'utf8')).toBe(autostartEntry([target.executable, '--hidden']));
    expect(readFileSync(target.autostart, 'utf8')).toContain(`\nExec=${target.executable} --hidden\n`);
  });

  it('replaces an earlier install as a whole', () => {
    installFiles({ packaged, helperSource, target });
    writeFileSync(join(target.appDir, 'left-over'), 'old');
    writeFileSync(join(packaged, 'resources/app/package.json'), '{"version":"3"}');

    installFiles({ packaged, helperSource, target });
    expect(readFileSync(join(target.appDir, 'resources/app/package.json'), 'utf8')).toBe('{"version":"3"}');
    expect(existsSync(join(target.appDir, 'left-over'))).toBe(false);
    expect(existsSync(`${target.appDir}.new`)).toBe(false);
    expect(existsSync(`${target.appDir}.old`)).toBe(false);
  });

  it('replaces a commander-show linked to a checkout without writing through the link', () => {
    const checkoutCopy = join(dir, 'checkout-commander-show');
    writeFileSync(checkoutCopy, 'the checkout’s own');
    mkdirSync(join(dir, 'local/bin'), { recursive: true });
    symlinkSync(checkoutCopy, target.helper);

    installFiles({ packaged, helperSource, target });
    expect(lstatSync(target.helper).isSymbolicLink()).toBe(false);
    expect(readFileSync(target.helper, 'utf8')).toBe('#!/bin/sh\necho show\n');
    expect(readFileSync(checkoutCopy, 'utf8')).toBe('the checkout’s own');
  });

  it('leaves the installed app alone when there is nothing packaged', () => {
    installFiles({ packaged, helperSource, target });
    expect(() => installFiles({ packaged: join(dir, 'nothing'), helperSource, target })).toThrow(
      /pnpm package/,
    );
    expect(mode(target.executable)).toBe(0o755);
  });
});

describe('appEnvironment', () => {
  it('leaves out what pnpm and Node add, and what would make Electron run as Node', () => {
    expect(
      appEnvironment({
        HOME: '/home/u',
        WAYLAND_DISPLAY: 'wayland-1',
        npm_lifecycle_event: 'install:local',
        PNPM_SCRIPT_SRC_DIR: '/src',
        NODE_OPTIONS: '--inspect',
        INIT_CWD: '/src',
        ELECTRON_RUN_AS_NODE: '1',
        PATH: '/src/apps/desktop/node_modules/.bin:/src/node_modules/.bin:/home/u/.local/bin:/usr/bin',
      }),
    ).toEqual({ HOME: '/home/u', WAYLAND_DISPLAY: 'wayland-1', PATH: '/home/u/.local/bin:/usr/bin' });
  });
});

// A stand-in for a running Commander: a real process that writes the pid file as the app does
// ("<pid> <start time>"), and on SIGTERM (the tray's Quit) saves, removes its pid file and exits, after
// `saveMs`; or never quits at all.
const fakeCommander = (
  pidFile: string,
  options: { savedFile?: string; saveMs?: number; ignoreQuit?: boolean },
) =>
  spawn(
    process.execPath,
    [
      '-e',
      `
      const fs = require('node:fs');
      const stat = fs.readFileSync('/proc/self/stat', 'utf8');
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      fs.writeFileSync(process.env.PID_FILE, process.pid + ' ' + start + '\\n');
      process.on('SIGTERM', () => {
        if (process.env.IGNORE_QUIT) return;
        setTimeout(() => {
          fs.writeFileSync(process.env.SAVED_FILE, 'saved');
          fs.rmSync(process.env.PID_FILE);
          process.exit(0);
        }, Number(process.env.SAVE_MS));
      });
      setInterval(() => {}, 1000);
      `,
    ],
    {
      env: {
        PID_FILE: pidFile,
        SAVED_FILE: options.savedFile ?? join(dir, 'saved'),
        SAVE_MS: String(options.saveMs ?? 0),
        ...(options.ignoreQuit ? { IGNORE_QUIT: '1' } : {}),
      },
      stdio: 'ignore',
    },
  );

async function started(child: ChildProcess, pidFile: string) {
  for (let i = 0; i < 100 && !findRunning(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
  expect(findRunning(pidFile)?.pid).toBe(child.pid);
}

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

describe('findRunning', () => {
  it('finds nothing without a pid file', () => {
    expect(findRunning(target.pidFile)).toBeNull();
  });

  it('ignores a stale pid file whose process has gone, or whose pid another process now has', () => {
    writeFileSync(target.pidFile, `${process.pid} 1\n`);
    expect(findRunning(target.pidFile)).toBeNull();
    writeFileSync(target.pidFile, '999999999 1\n');
    expect(findRunning(target.pidFile)).toBeNull();
  });

  it('finds the process that wrote it, and what it runs', async () => {
    const child = fakeCommander(target.pidFile, {});
    children.push(child);
    await started(child, target.pidFile);
    expect(findRunning(target.pidFile)).toMatchObject({ pid: child.pid, executable: process.execPath });
  });
});

describe('installReplacing', () => {
  const quiet = () => {};

  it('installs without starting anything when Commander is not running', async () => {
    const steps: string[] = [];
    const outcome = await installReplacing({
      target,
      install: () => {
        steps.push('install');
        return { startAtLogin: 'off' };
      },
      start: () => steps.push('start'),
      log: quiet,
    });
    expect(outcome).toBe('installed');
    expect(steps).toEqual(['install']);
  });

  it('asks a running Commander to quit, waits for it to save and exit, installs, then starts it again', async () => {
    const savedFile = join(dir, 'saved');
    const running = fakeCommander(target.pidFile, { savedFile, saveMs: 300 });
    children.push(running);
    await started(running, target.pidFile);

    const steps: string[] = [];
    const lines: string[] = [];
    const outcome = await installReplacing({
      target,
      install: () => {
        // By now it has saved and gone.
        steps.push(
          `install (saved: ${existsSync(savedFile)}, running: ${findRunning(target.pidFile) !== null})`,
        );
        return installFiles({ packaged, helperSource, target });
      },
      start: () => {
        steps.push('start');
        children.push(fakeCommander(target.pidFile, {}));
      },
      log: (line) => lines.push(line),
      pollMs: 20,
    });

    expect(outcome).toBe('replaced');
    expect(steps).toEqual(['install (saved: true, running: false)', 'start']);
    expect(running.exitCode).toBe(0);
    expect(findRunning(target.pidFile)?.pid).toBe(children.at(-1)?.pid);
    expect(lines.join('\n')).toMatch(/Asking the running Commander \(pid \d+\) to quit/);
    expect(lines.at(-1)).toBe('Started Commander again.');
  });

  it('installs nothing when Commander does not quit in time', async () => {
    const running = fakeCommander(target.pidFile, { ignoreQuit: true });
    children.push(running);
    await started(running, target.pidFile);

    const steps: string[] = [];
    const outcome = await installReplacing({
      target,
      install: () => {
        steps.push('install');
        return { startAtLogin: 'off' };
      },
      start: () => steps.push('start'),
      log: quiet,
      quitTimeoutMs: 300,
      pollMs: 20,
    });
    expect(outcome).toBe('still running');
    expect(steps).toEqual([]);
    expect(findRunning(target.pidFile)?.pid).toBe(running.pid);
  });
});
