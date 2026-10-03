import { expect, type Page } from '@playwright/test';

// Helpers for driving the app frame in end-to-end tests.

/** Opens Settings from the button on the tabs' right edge. */
export async function openSettings(window: Page): Promise<void> {
  await window
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await expect(window.getByTestId('settings')).toBeVisible();
}

/** The notebook tab for a Section, by its label. */
export const tab = (window: Page, label: string) =>
  window.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: label, exact: true });
