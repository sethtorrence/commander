import { _electron as electron, expect, test } from '@playwright/test';

test('Commander launches and shows the core heartbeat climbing', async () => {
  const app = await electron.launch({
    args: ['.', '--ozone-platform-hint=auto', '--password-store=gnome-libsecret'],
  });
  const window = await app.firstWindow();

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
  const app = await electron.launch({
    args: ['.', '--ozone-platform-hint=auto', '--password-store=gnome-libsecret'],
  });
  const window = await app.firstWindow();

  await expect(window.getByTestId('display-server')).toHaveText('wayland');
  await expect(window.getByTestId('password-store')).toHaveText('gnome-libsecret');

  await app.close();
});
