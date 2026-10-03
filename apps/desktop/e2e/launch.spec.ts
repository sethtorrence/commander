import { expect, test } from '@playwright/test';
import { openSettings } from './frame';
import { launchCommander } from './launch-commander';

test('Commander launches and Settings → Diagnostics shows the core heartbeat climbing', async () => {
  const { app } = await launchCommander();
  const window = await app.firstWindow();
  await openSettings(window);

  const beats = window.getByTestId('core-heartbeat');
  await expect(beats).toHaveText(/\d+/, { timeout: 10_000 });
  const first = Number(await beats.textContent());
  await expect
    .poll(async () => Number(await beats.textContent()), { timeout: 10_000 })
    .toBeGreaterThan(first);

  await app.close();
});

test('on a Wayland session Commander runs as a native Wayland client with the keyring store', async () => {
  test.skip(!process.env.WAYLAND_DISPLAY, 'needs a Wayland session');
  const { app } = await launchCommander();
  const window = await app.firstWindow();
  await openSettings(window);

  await expect(window.getByTestId('display-server')).toHaveText('wayland');
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    await expect(window.getByTestId('display-source')).toHaveText('compositor');
  }
  await expect(window.getByTestId('password-store')).toHaveText('gnome-libsecret');

  await app.close();
});
