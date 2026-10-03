// Command-line switches Commander needs before Electron is ready.
// On Linux: run natively on Wayland, and store secrets in the real keyring
// (Chromium otherwise falls back to unencrypted basic_text on Hyprland).
export type Switch = readonly [name: string, value: string];

export function launchSwitches(platform: NodeJS.Platform): Switch[] {
  if (platform !== 'linux') return [];
  return [
    ['ozone-platform-hint', 'auto'],
    ['password-store', 'gnome-libsecret'],
  ];
}
