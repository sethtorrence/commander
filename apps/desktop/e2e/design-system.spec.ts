import { expect, type Page, test } from '@playwright/test';
import { openSettings } from './frame';
import { launchCommander } from './launch-commander';

const PLATES = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'];

async function openGallery(window: Page) {
  await openSettings(window);
  await window.getByRole('link', { name: /design gallery/i }).click();
  await expect(window.getByTestId('design-gallery')).toBeVisible();
}

const rootVariable = (window: Page, name: string) =>
  window.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test('the design gallery shows every plate in both themes, with the bundled fonts', async () => {
  const commander = await launchCommander();
  const window = await commander.app.firstWindow();
  const cspViolations: string[] = [];
  window.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) cspViolations.push(message.text());
  });

  await openGallery(window);
  for (const plate of PLATES) {
    await expect(window.getByTestId(`plate-${plate}-dark`)).toBeAttached();
    await expect(window.getByTestId(`plate-${plate}-light`)).toBeAttached();
  }

  const fonts = await window.evaluate(async () => {
    await document.fonts.ready;
    const faces = [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family);
    // Every @font-face source in the app's stylesheets.
    const files = [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules])
      .filter((rule) => rule instanceof CSSFontFaceRule)
      .flatMap((rule) => [...rule.style.getPropertyValue('src').matchAll(/url\("?([^")]+)"?\)/g)])
      .map((match) => match[1] ?? '');
    return { faces, files };
  });
  expect(fonts.faces.some((family) => family.includes('Archivo'))).toBe(true);
  expect(fonts.faces.some((family) => family.includes('IBM Plex Mono'))).toBe(true);
  expect(fonts.files.length).toBeGreaterThan(0);
  for (const file of fonts.files) expect(file).not.toMatch(/^https?:/);
  expect(cspViolations).toEqual([]);

  await commander.close();
});

test('the theme toggle switches light and dark, and the choice survives a restart', async () => {
  const first = await launchCommander();
  const window = await first.app.firstWindow();
  await openGallery(window);

  await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark');
  await window.getByRole('button', { name: 'Switch to light' }).click();
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await rootVariable(window, '--sheet')).toBe('#e9e7e2');
  await first.app.close();

  const again = await launchCommander({ userDataDir: first.userDataDir });
  const reopened = await again.app.firstWindow();
  await expect(reopened.getByRole('navigation', { name: 'Sections' })).toBeVisible();
  await expect(reopened.locator('html')).toHaveAttribute('data-theme', 'light');
  await again.close();
});

test('picking a signal colour recolours live things at once and is remembered', async () => {
  const first = await launchCommander();
  const window = await first.app.firstWindow();
  await openGallery(window);

  const liveEyebrow = window
    .getByTestId('plate-09-light')
    .locator('[data-slot=sheet-strip] > [data-cell]')
    .first();
  await expect(liveEyebrow).toHaveCSS('background-color', 'rgb(230, 86, 0)');

  await window.getByRole('radio', { name: 'Phosphor green' }).click();
  // Light theme: the green is deepened until lines reach 3:1 on the concrete sheet.
  await expect(liveEyebrow).toHaveCSS('background-color', 'rgb(0, 152, 78)');
  expect(await rootVariable(window, '--signal')).toBe('#00E676');
  await first.app.close();

  const again = await launchCommander({ userDataDir: first.userDataDir });
  const reopened = await again.app.firstWindow();
  await expect(reopened.getByRole('navigation', { name: 'Sections' })).toBeVisible();
  await expect.poll(() => rootVariable(reopened, '--signal')).toBe('#00E676');
  await again.close();
});
