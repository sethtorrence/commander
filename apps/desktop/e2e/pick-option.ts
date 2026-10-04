import { expect, type Locator } from '@playwright/test';

// Picks an option from a pop-up select. Pop-ups close when the window loses focus, which another
// window on the desktop (often another test run) can take mid-test, so the pick is retried until
// the select shows the choice.
export async function pickOption(
  combobox: Locator,
  option: string | RegExp,
  shows: string | RegExp = option,
) {
  const page = combobox.page();
  const choice =
    typeof option === 'string'
      ? page.getByRole('option', { name: option, exact: true })
      : page.getByRole('option', { name: option });
  await expect(async () => {
    if ((await combobox.getAttribute('aria-expanded')) !== 'true') await combobox.click();
    await choice.click({ timeout: 2000 });
    await expect(combobox).toHaveText(shows, { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
}
