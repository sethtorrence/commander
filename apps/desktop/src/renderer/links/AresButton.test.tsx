// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShortcutProvider, useShortcutList, useShortcuts } from '../shortcuts/react';
import { type AresActions, AresProvider, type AresTarget, AskAres, useAresKey } from './AresButton';

// The shared Ares button on an Item (#193), and `a` for the focused Item.

afterEach(cleanup);

const email: AresTarget = { id: 'm1', kind: 'email', title: 'Q4 offsite dates' };

function Section({ focused }: { focused: AresTarget | null }) {
  useShortcuts([useAresKey(focused)]);
  const listed = useShortcutList();
  return (
    <>
      <span data-testid="listed">
        {listed.map((each) => `${each.keys.join('+')} ${each.label}`).join(', ')}
      </span>
      <AskAres item={email} />
      <AskAres item={email} variant="pane" />
    </>
  );
}

function show(focused: AresTarget | null, actions: AresActions | null) {
  const section = <Section focused={focused} />;
  render(
    <ShortcutProvider>
      {actions ? <AresProvider value={actions}>{section}</AresProvider> : section}
    </ShortcutProvider>,
  );
}

describe('the Ares button on an Item', () => {
  it('opens the pop-up on its Item, beside itself, without opening the row it is on', () => {
    const open = vi.fn();
    const onRow = vi.fn();
    render(
      <AresProvider value={{ open }}>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: a stand-in for a row that opens on a click */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: as above */}
        <div onClick={onRow}>
          <AskAres item={email} />
        </div>
      </AresProvider>,
    );
    const button = screen.getByRole('button', { name: 'Ask Ares about Q4 offsite dates' });
    fireEvent.click(button);
    expect(open).toHaveBeenCalledWith(email, button);
    expect(onRow).not.toHaveBeenCalled();
  });

  it('draws nothing, and a does nothing, without the pop-up above it', () => {
    show(email, null);
    expect(screen.queryAllByTestId('ares-button')).toHaveLength(0);
    fireEvent.keyDown(window, { key: 'a' });
  });

  it('a opens it on the focused Item, beside its pane’s button; it is listed for `?`', () => {
    const open = vi.fn();
    show(email, { open });
    expect(screen.getByTestId('listed').textContent).toBe('A Ask Ares about it');
    fireEvent.keyDown(window, { key: 'a' });
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0]?.[0]).toBe(email);
    // jsdom lays nothing out, so neither button counts as shown: no anchor, and it opens at the side.
    expect(open.mock.calls[0]?.[1]).toBeNull();
  });

  it('a does nothing while no Item is focused', () => {
    const open = vi.fn();
    show(null, { open });
    fireEvent.keyDown(window, { key: 'a' });
    expect(open).not.toHaveBeenCalled();
  });

  it('a is typing in a field, never the Ares key', () => {
    const open = vi.fn();
    render(
      <ShortcutProvider>
        <AresProvider value={{ open }}>
          <Section focused={email} />
          <input aria-label="Search" />
        </AresProvider>
      </ShortcutProvider>,
    );
    const field = screen.getByRole('textbox', { name: 'Search' });
    field.focus();
    fireEvent.keyDown(field, { key: 'a' });
    expect(open).not.toHaveBeenCalled();
  });
});
