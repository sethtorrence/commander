// @vitest-environment jsdom
import type { ActivityEntry, Item } from '@commander/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ItemStoreClient } from '../item-store/client';
import { ItemWarning, WarningActionsProvider, warningActionsIn } from './ItemWarning';

// An Item's warning mark offers Not an instruction where it is shown (#201), in rows and panes alike,
// and an Item Ares sent to no model carries a small note.

afterEach(cleanup);

const T = Date.UTC(2026, 9, 6, 0, 5);
const WARNING = 'This email contains instructions aimed at Ares. He ignored them.';
const SKIPPED =
  'Ares skipped this email: it holds what looks like one of your keys or sign-in tokens, so none of it went to a model.';

const email = (overrides: Partial<Item> = {}): Item => ({
  id: 'mail-1',
  kind: 'email',
  source: 'gmail',
  account: 'google:alex',
  externalId: 'mail-1',
  title: 'Invoice from Dana',
  people: [],
  filing: null,
  status: 'open',
  detail: null,
  createdAt: T,
  updatedAt: T,
  deletedAt: null,
  ...overrides,
});

describe('ItemWarning', () => {
  it('shows nothing for an ordinary Item', () => {
    const { container } = render(<ItemWarning item={email()} />);
    expect(container.textContent).toBe('');
  });

  it('only says what the mark is where nothing can clear it', () => {
    render(<ItemWarning item={email({ injectionWarning: { at: T } })} variant="pane" />);
    expect(screen.getByRole('note').textContent).toContain(WARNING);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers Not an instruction on a pane and on a row, clearing that Item', () => {
    const clear = vi.fn();
    const marked = email({ injectionWarning: { at: T } });
    render(
      <WarningActionsProvider value={{ clear }}>
        <ItemWarning item={marked} variant="pane" />
      </WarningActionsProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Not an instruction' }));
    expect(clear).toHaveBeenCalledWith(marked);
    cleanup();

    render(
      <WarningActionsProvider value={{ clear }}>
        <ItemWarning item={marked} />
      </WarningActionsProvider>,
    );
    expect(screen.getByRole('note', { name: WARNING })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'About this warning' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not an instruction' }));
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it('notes an Item Ares skipped, on a row and a pane', () => {
    render(<ItemWarning item={email({ refusal: { at: T } })} />);
    expect(screen.getByRole('note', { name: SKIPPED }).textContent).toBe('Skipped');
    cleanup();
    render(<ItemWarning item={email({ refusal: { at: T } })} variant="pane" />);
    expect(screen.getByRole('note').textContent).toContain(SKIPPED);
  });
});

describe('warningActionsIn', () => {
  it('clears through the Item store, as the User', async () => {
    const requests: unknown[] = [];
    const entry = { id: 41 } as ActivityEntry;
    const client = (async (request: unknown) => {
      requests.push(request);
      return entry;
    }) as unknown as ItemStoreClient;
    warningActionsIn(client).clear(email({ injectionWarning: { at: T } }));
    await waitFor(() => expect(requests).toEqual([{ op: 'clear-injection-warning', itemId: 'mail-1' }]));
  });
});
