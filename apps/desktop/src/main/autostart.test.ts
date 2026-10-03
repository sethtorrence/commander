import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  autostartEntry,
  autostartPath,
  isAutostartEnabled,
  launchAtLoginCommand,
  setAutostart,
} from './autostart';

describe('autostartPath', () => {
  it('is commander.desktop in the XDG autostart directory', () => {
    expect(autostartPath({ XDG_CONFIG_HOME: '/home/u/.cfg' }, '/home/u')).toBe(
      '/home/u/.cfg/autostart/commander.desktop',
    );
  });

  it('defaults the config directory to ~/.config', () => {
    expect(autostartPath({}, '/home/u')).toBe('/home/u/.config/autostart/commander.desktop');
  });
});

describe('launchAtLoginCommand', () => {
  it('starts the packaged app hidden in the tray', () => {
    expect(
      launchAtLoginCommand({ execPath: '/opt/Commander/commander', appPath: '/x', isPackaged: true }),
    ).toEqual(['/opt/Commander/commander', '--hidden']);
  });

  it('starts a development build through Electron with the app path', () => {
    expect(
      launchAtLoginCommand({ execPath: '/n/electron', appPath: '/src/apps/desktop', isPackaged: false }),
    ).toEqual(['/n/electron', '/src/apps/desktop', '--hidden']);
  });
});

describe('autostartEntry', () => {
  it('is a desktop entry that runs the command', () => {
    const entry = autostartEntry(['/opt/Commander/commander', '--hidden']);
    expect(entry.startsWith('[Desktop Entry]\n')).toBe(true);
    expect(entry).toContain('\nType=Application\n');
    expect(entry).toContain('\nName=Commander\n');
    expect(entry).toContain('\nExec=/opt/Commander/commander --hidden\n');
    expect(entry.endsWith('\n')).toBe(true);
  });

  it('quotes arguments the way the desktop entry spec asks', () => {
    const entry = autostartEntry(['/home/u/My Apps/electron', '/src/"odd" $dir\\x', '100%']);
    expect(entry).toContain(
      '\nExec="/home/u/My Apps/electron" "/src/\\\\"odd\\\\" \\\\$dir\\\\\\\\x" 100%%\n',
    );
  });
});

describe('setAutostart and isAutostartEnabled', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'commander-autostart-'));
    path = join(dir, 'autostart', 'commander.desktop');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is off by default: no entry exists until the User turns it on', () => {
    expect(isAutostartEnabled(path)).toBe(false);
  });

  it('turning it on writes the entry, creating the autostart directory', () => {
    setAutostart(path, true, ['/opt/Commander/commander', '--hidden']);
    expect(isAutostartEnabled(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(autostartEntry(['/opt/Commander/commander', '--hidden']));
  });

  it('turning it off removes the entry', () => {
    setAutostart(path, true, ['/opt/Commander/commander']);
    setAutostart(path, false, ['/opt/Commander/commander']);
    expect(existsSync(path)).toBe(false);
    expect(isAutostartEnabled(path)).toBe(false);
  });

  it('turning it off when already off is fine', () => {
    expect(() => setAutostart(path, false, [])).not.toThrow();
  });
});
