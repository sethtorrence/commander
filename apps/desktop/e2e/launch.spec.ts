import { expect, test } from '@playwright/test';
import { openSettings } from './frame';
import { launchCommander } from './launch-commander';

test('Commander launches and Settings → Diagnostics shows the Core healthy, its heartbeat climbing', async () => {
  const { app } = await launchCommander();
  const window = await app.firstWindow();
  await openSettings(window, 'Diagnostics');

  const health = window.getByTestId('core-health');
  await expect(health).toHaveText('Healthy', { timeout: 10_000 });
  const beats = async () => Number(await health.getAttribute('data-beats'));
  const first = await beats();
  await expect.poll(beats, { timeout: 10_000 }).toBeGreaterThan(first);

  await app.close();
});

test('on a Wayland session Commander runs as a native Wayland client with the keyring store', async () => {
  test.skip(!process.env.WAYLAND_DISPLAY, 'needs a Wayland session');
  const { app } = await launchCommander();
  const window = await app.firstWindow();
  await openSettings(window, 'Diagnostics');

  await expect(window.getByTestId('display-server')).toHaveText('wayland');
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    await expect(window.getByTestId('display-source')).toHaveText('compositor');
  }
  await expect(window.getByTestId('password-store')).toHaveText('gnome-libsecret');

  await app.close();
});
