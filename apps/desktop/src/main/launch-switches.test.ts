import { describe, expect, it } from 'vitest';
import { launchSwitches } from './launch-switches';

describe('launchSwitches', () => {
  it('runs natively on Wayland and keeps tokens in the real keyring on Linux', () => {
    expect(launchSwitches('linux')).toEqual([
      ['ozone-platform-hint', 'auto'],
      ['password-store', 'gnome-libsecret'],
    ]);
  });

  it('adds no switches on macOS or Windows', () => {
    expect(launchSwitches('darwin')).toEqual([]);
    expect(launchSwitches('win32')).toEqual([]);
  });
});
