// @vitest-environment jsdom
import type { CalendarSettings as Settings } from '@commander/domain';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ItemStoreClient } from '../item-store/client';
import { CalendarSettings } from './CalendarSettings';

// Settings → Calendar stays mounted while Settings is closed, so it reads the heads-up again each time
// its page is shown: a change the User confirmed in a Conversation (#197) shows there.

afterEach(cleanup);

describe('Settings → Calendar', () => {
  it('reads the heads-up again each time its page is shown', async () => {
    let saved: Settings = { headsUp: false };
    const itemStore = ((request: { op: string }) =>
      request.op === 'calendar-settings'
        ? Promise.resolve(saved)
        : new Promise(() => {})) as unknown as ItemStoreClient;
    const { rerender } = render(<CalendarSettings no="01" itemStore={itemStore} shown />);
    const toggle = screen.getByTestId('meeting-heads-up');
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));

    // Turned on from a Conversation while the page was hidden.
    rerender(<CalendarSettings no="01" itemStore={itemStore} shown={false} />);
    saved = { headsUp: true };
    rerender(<CalendarSettings no="01" itemStore={itemStore} shown />);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  });
});
