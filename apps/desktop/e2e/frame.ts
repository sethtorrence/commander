import { expect, type Page } from '@playwright/test';

// Helpers for driving the app frame in end-to-end tests.

/**
 * Opens Settings from the button on the tabs' right edge, then the page named (as in its sidebar:
 * "Accounts") when given. Settings opens on the page it was left at (General at first).
 */
export async function openSettings(window: Page, page?: string): Promise<void> {
  await window
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await expect(window.getByTestId('settings')).toBeVisible();
  if (page) await settingsPage(window, page);
}

/** Opens a page of Settings from its sidebar, by its name: "Accounts". */
export async function settingsPage(window: Page, page: string): Promise<void> {
  const link = window
    .getByRole('navigation', { name: 'Settings pages' })
    .getByRole('button', { name: page, exact: true });
  await link.click();
  await expect(link).toHaveAttribute('aria-current', 'page');
}

/** The notebook tab for a Section, by its label. */
export const tab = (window: Page, label: string) =>
  window.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: label, exact: true });
