import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processStartTime } from './pid-file';

// The helper a Hyprland bind runs. These tests run the real script against a fake `hyprctl`
// (it logs its arguments and plays a Lua or text config) and a stand-in for the app: a `sleep`
// process, which SIGUSR1 terminates, so we can see whether the signal reached it.
const helper = resolve(__dirname, '../../bin/commander-show');

const fakeHyprctl = `#!/bin/sh
echo "$*" >> "$FAKE_DIR/hyprctl.log"
if [ "$1" = "-j" ] && [ "$2" = "status" ]; then
  if [ "$FAKE_PROVIDER" = lua ]; then printf '{\\n    "configProvider": "lua",\\n    "backend": "drm"\\n}\\n'
  else echo 'unknown request'; fi
  exit 0
fi
# The window takes a moment to map after the app shows it: report it missing FAKE_MISSING times.
n=$(cat "$FAKE_DIR/missing" 2>/dev/null || echo 0)
if [ "$n" -lt "\${FAKE_MISSING:-0}" ]; then
  echo $((n + 1)) > "$FAKE_DIR/missing"
  if [ "$FAKE_PROVIDER" = lua ]; then echo 'warning: =[C]:-1: hl.focus: window not found'; else echo 'No such window found'; fi
  exit 0
fi
echo ok
`;

type Run = { code: number; stderr: string };

describe('commander-show', () => {
  let dir: string;
  let app: ChildProcess;
  let appExit: Promise<NodeJS.Signals | null>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'commander-show-'));
    writeFileSync(join(dir, 'hyprctl'), fakeHyprctl);
    chmodSync(join(dir, 'hyprctl'), 0o755);
    app = spawn('sleep', ['30']);
    appExit = new Promise((done) => app.on('exit', (_code, signal) => done(signal)));
  });

  afterEach(() => {
    app.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });

  const pidFile = () => join(dir, 'commander.pid');
  const startTimeOf = (pid: number) => processStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  const writeRecord = (pid = app.pid as number, startTime = startTimeOf(pid)) =>
    writeFileSync(pidFile(), `${pid} ${startTime}\n`);
  const hyprctlCalls = () => {
    try {
      return readFileSync(join(dir, 'hyprctl.log'), 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };

  function run(env: Record<string, string> = {}): Promise<Run> {
    return new Promise((done) => {
      execFile(
        helper,
        [],
        {
          env: {
            PATH: `${dir}:${process.env.PATH}`,
            COMMANDER_PID_FILE: pidFile(),
            HYPRLAND_INSTANCE_SIGNATURE: 'test',
            FAKE_DIR: dir,
            ...env,
          },
        },
        (error, _stdout, stderr) => done({ code: error ? Number(error.code) : 0, stderr }),
      );
    });
  }

  it('signals the running app, then focuses it with hl.dsp.focus on a Lua config', async () => {
    writeRecord();
    const result = await run({ FAKE_PROVIDER: 'lua' });
    expect(result.code).toBe(0);
    expect(await appExit).toBe('SIGUSR1');
    expect(hyprctlCalls()).toEqual([
      '-j status',
      'dispatch hl.dsp.focus({ window = "class:^(commander)$" })',
    ]);
  });

  it('focuses with focuswindow on a text config', async () => {
    writeRecord();
    const result = await run({ FAKE_PROVIDER: 'text' });
    expect(result.code).toBe(0);
    expect(hyprctlCalls()).toEqual(['-j status', 'dispatch focuswindow class:^(commander)$']);
  });

  it.each(['lua', 'text'])(
    'retries the focus until the shown window is mapped (%s config)',
    async (provider) => {
      writeRecord();
      const result = await run({ FAKE_PROVIDER: provider, FAKE_MISSING: '2' });
      expect(result.code).toBe(0);
      expect(hyprctlCalls().filter((call) => call.startsWith('dispatch'))).toHaveLength(3);
    },
  );

  it('only signals outside Hyprland, where the app can raise its own window', async () => {
    writeRecord();
    const result = await run({ HYPRLAND_INSTANCE_SIGNATURE: '' });
    expect(result.code).toBe(0);
    expect(await appExit).toBe('SIGUSR1');
    expect(hyprctlCalls()).toEqual([]);
  });

  it('never signals a process that merely reuses a stale pid', async () => {
    writeRecord(app.pid as number, '1');
    const result = await run({ FAKE_PROVIDER: 'lua' });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not running/);
    expect(app.exitCode).toBeNull();
    expect(app.signalCode).toBeNull();
    expect(hyprctlCalls()).toEqual([]);
  });

  it('says Commander is not running when there is no pid file', async () => {
    const result = await run({ FAKE_PROVIDER: 'lua' });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not running/);
  });
});
