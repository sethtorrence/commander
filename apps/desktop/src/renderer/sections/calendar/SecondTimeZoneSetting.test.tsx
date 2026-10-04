// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestItemStore } from '../../item-store/test-item-store';
import { CalendarSettings } from '../../settings/CalendarSettings';

// Settings → Calendar's second time zone, against a real Item store: typed and saved with Enter,
// refused when it isn't a zone, taken away with None, and kept when the heads-up changes.

const NOW = Date.parse('2026-10-05T14:00:00Z');
let store: ItemStore;
let close: () => void;
let client: ReturnType<typeof openTestItemStore>['client'];

beforeEach(() => {
  ({ store, close, client } = openTestItemStore(() => NOW));
});

afterEach(() => {
  cleanup();
  close();
});

const field = () => screen.getByRole('combobox', { name: 'Second time zone' }) as HTMLInputElement;

describe('the second time zone setting', () => {
  it('saves a zone on Enter, refuses one it doesn’t know, and None takes it away', async () => {
    render(<CalendarSettings no="15" itemStore={client} />);
    fireEvent.change(field(), { target: { value: 'Mars/Olympus_Mons' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(screen.getByText('Not a time zone this computer knows')).toBeTruthy();
    expect(store.calendarSettings.read().secondTimeZone ?? null).toBeNull();

    fireEvent.change(field(), { target: { value: 'America/New_York' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(store.calendarSettings.read().secondTimeZone).toBe('America/New_York'));
    await waitFor(() => expect(screen.getByText(/^New York · \d\d:\d\d there now$/)).toBeTruthy());

    // The heads-up changes; the zone stays.
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Notify me 2 minutes before a meeting' }));
    });
    await waitFor(() => expect(store.calendarSettings.read().headsUp).toBe(true));
    expect(store.calendarSettings.read().secondTimeZone).toBe('America/New_York');

    fireEvent.click(screen.getByRole('button', { name: 'None' }));
    await waitFor(() => expect(store.calendarSettings.read().secondTimeZone ?? null).toBeNull());
    await waitFor(() => expect(field().value).toBe(''));
  });
});
