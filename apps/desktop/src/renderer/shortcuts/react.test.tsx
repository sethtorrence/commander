// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShortcutProvider, ShortcutScope, useActiveScopes, useShortcutList, useShortcuts } from './react';

afterEach(cleanup);

function TickTodos({ onTick }: { onTick: () => void }) {
  useShortcuts([{ keys: 'x', label: 'Tick a Todo', run: onTick }]);
  return null;
}

function Listing() {
  const list = useShortcutList();
  return (
    <output>
      {list.map((s) => `${s.keys.join('+')} ${s.label} [${s.group}]${s.active ? '' : ' off'}`).join(', ')}
    </output>
  );
}

function Frame({ open, onTick, todos = true }: { open: string; onTick: () => void; todos?: boolean }) {
  useActiveScopes([open]);
  return (
    <>
      {todos && (
        <ShortcutScope scope="todos" group="Todos">
          <TickTodos onTick={onTick} />
        </ShortcutScope>
      )}
      <Listing />
    </>
  );
}

describe('useShortcuts', () => {
  it("scopes a Section's keys to that Section and lists them under its name", () => {
    const onTick = vi.fn();
    const { container, rerender } = render(
      <ShortcutProvider>
        <Frame open="notes" onTick={onTick} />
      </ShortcutProvider>,
    );

    fireEvent.keyDown(document.body, { key: 'x' });
    expect(onTick).not.toHaveBeenCalled();
    expect(container.textContent).toBe('X Tick a Todo [Todos] off');

    rerender(
      <ShortcutProvider>
        <Frame open="todos" onTick={onTick} />
      </ShortcutProvider>,
    );
    fireEvent.keyDown(document.body, { key: 'x' });
    expect(onTick).toHaveBeenCalledOnce();
    expect(container.textContent).toBe('X Tick a Todo [Todos]');
  });

  it('calls the latest handler without registering again, and unregisters on unmount', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { container, rerender } = render(
      <ShortcutProvider>
        <Frame open="todos" onTick={first} />
      </ShortcutProvider>,
    );
    rerender(
      <ShortcutProvider>
        <Frame open="todos" onTick={second} />
      </ShortcutProvider>,
    );
    fireEvent.keyDown(document.body, { key: 'x' });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();

    act(() =>
      rerender(
        <ShortcutProvider>
          <Frame open="todos" onTick={second} todos={false} />
        </ShortcutProvider>,
      ),
    );
    expect(container.textContent).toBe('');
  });
});
