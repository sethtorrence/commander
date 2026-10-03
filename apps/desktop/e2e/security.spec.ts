import { expect, test } from '@playwright/test';
import { openSettings } from './frame';
import { launchCommander } from './launch-commander';

// On Linux/Wayland (the author's Hyprland) Commander launches with --password-store=gnome-libsecret,
// so secrets must be protected by the Secret Service keyring.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

test('Settings → Security shows the libsecret keyring protecting secrets', async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  const { app } = await launchCommander();
  const window = await app.firstWindow();
  await openSettings(window);

  const panel = window.getByTestId('security-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('security-backend')).toHaveText('gnome_libsecret');
  await expect(panel.getByTestId('security-protected')).toHaveText('Protected by the system keyring');
  await expect(panel.getByTestId('security-problem')).toHaveCount(0);

  await app.close();
});

test('a secret survives a save, read and delete round trip through the real keyring', async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  const { app } = await launchCommander({ env: { COMMANDER_SECRETS_SELF_TEST: '1' } });
  await app.firstWindow();

  // The self-test runs in the main process; its report never passes through the window.
  const report = await app.evaluate(
    () => (globalThis as { commanderSecretsSelfTest?: Promise<unknown> }).commanderSecretsSelfTest,
  );

  expect(report).toEqual({
    backend: 'gnome_libsecret',
    protected: true,
    readBack: true,
    plaintextOnDisk: false,
    fileMode: '600',
    goneAfterDelete: true,
    error: null,
  });

  await app.close();
});
