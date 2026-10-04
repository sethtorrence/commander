// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ItemStoreClient } from '../../item-store/client';
import { openTestItemStore } from '../../item-store/test-item-store';
import { OversightSettings } from './OversightSettings';

// Settings → GitHub → Oversight summary (#119): the two Stuck settings and the bots, against a real
// Item store.

let store: ItemStore;
let client: ItemStoreClient;
let close: () => void;

beforeEach(() => {
  ({ store, client, close } = openTestItemStore());
});

afterEach(() => {
  cleanup();
  close();
});

describe('Settings → GitHub → Oversight summary', () => {
  it('shows the defaults, and saves each setting when its field is left', async () => {
    render(<OversightSettings itemStore={client} />);
    const old = screen.getByLabelText('Stuck after days open') as HTMLInputElement;
    const idle = screen.getByLabelText('Stuck after days without activity') as HTMLInputElement;
    const bots = screen.getByLabelText('Bots') as HTMLInputElement;
    await waitFor(() => expect(old.value).toBe('7'));
    expect(idle.value).toBe('5');
    expect(bots.value).toBe('dependabot, renovate');

    fireEvent.change(old, { target: { value: '10' } });
    fireEvent.blur(old);
    fireEvent.change(idle, { target: { value: '3' } });
    fireEvent.blur(idle);
    fireEvent.change(bots, { target: { value: 'dependabot, acme-release-bot' } });
    fireEvent.blur(bots);
    await waitFor(() =>
      expect(store.githubOversight.settings()).toEqual({
        longRunningDays: 10,
        idleDays: 3,
        bots: ['dependabot', 'acme-release-bot'],
      }),
    );
  });

  it('puts back a number of days that makes no sense', async () => {
    render(<OversightSettings itemStore={client} />);
    const old = screen.getByLabelText('Stuck after days open') as HTMLInputElement;
    await waitFor(() => expect(old.value).toBe('7'));
    fireEvent.change(old, { target: { value: '0' } });
    fireEvent.blur(old);
    await waitFor(() => expect(old.value).toBe('7'));
    expect(store.githubOversight.settings().longRunningDays).toBe(7);
  });
});
