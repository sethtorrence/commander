import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pidFilePath, processStartTime, removePidFile, writePidFile } from './pid-file';

describe('pidFilePath', () => {
  it('lives in the runtime directory of the session', () => {
    expect(pidFilePath({ env: { XDG_RUNTIME_DIR: '/run/user/1000' }, uid: 1000 })).toBe(
      '/run/user/1000/commander.pid',
    );
  });

  it('falls back to a per-user file in the temp directory without a runtime directory', () => {
    expect(pidFilePath({ env: {}, uid: 1000 })).toBe('/tmp/commander-1000.pid');
    expect(pidFilePath({ env: { TMPDIR: '/var/tmp' }, uid: 1000 })).toBe('/var/tmp/commander-1000.pid');
  });

  it('keeps an instance on a throwaway profile (--user-data-dir) away from the real one', () => {
    expect(
      pidFilePath({
        env: { XDG_RUNTIME_DIR: '/run/user/1000' },
        uid: 1000,
        customUserDataDir: '/tmp/profile-1',
      }),
    ).toBe('/tmp/profile-1/commander.pid');
  });

  it('can be pointed anywhere with COMMANDER_PID_FILE', () => {
    const env = { COMMANDER_PID_FILE: '/x/test.pid', XDG_RUNTIME_DIR: '/run/user/1000' };
    expect(pidFilePath({ env, uid: 1000, customUserDataDir: '/tmp/profile-1' })).toBe('/x/test.pid');
  });
});

describe('processStartTime', () => {
  // /proc/<pid>/stat: the command name is in parentheses and may itself hold spaces and ")".
  const stat = (comm: string) =>
    `4242 (${comm}) S 1 4242 4242 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 30 0 987654 1234567 890 18446744073709551615`;

  it('reads the start time (field 22) of a process', () => {
    expect(processStartTime(stat('electron'))).toBe('987654');
  });

  it('is not fooled by spaces or parentheses in the command name', () => {
    expect(processStartTime(stat('Web Content (x) y'))).toBe('987654');
  });

  it('knows nothing when the stat line is malformed', () => {
    expect(processStartTime('garbage')).toBeNull();
  });
});

describe('writePidFile and removePidFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'commander-pid-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('records the pid and its start time, so a reused pid is never signalled', () => {
    const path = join(dir, 'run', 'commander.pid');
    writePidFile(path, { pid: 4242, startTime: '987654' });
    expect(readFileSync(path, 'utf8')).toBe('4242 987654\n');
  });

  it('removes the file it wrote', () => {
    const path = join(dir, 'commander.pid');
    const record = { pid: 4242, startTime: '987654' };
    writePidFile(path, record);
    removePidFile(path, record);
    expect(() => readFileSync(path)).toThrow();
  });

  it("leaves another instance's file alone", () => {
    const path = join(dir, 'commander.pid');
    writeFileSync(path, '5555 111\n');
    removePidFile(path, { pid: 4242, startTime: '987654' });
    expect(readFileSync(path, 'utf8')).toBe('5555 111\n');
  });

  it('does not mind the file already being gone', () => {
    expect(() => removePidFile(join(dir, 'missing.pid'), { pid: 1, startTime: '1' })).not.toThrow();
  });
});
