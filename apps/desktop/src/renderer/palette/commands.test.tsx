// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShortcutProvider, useShortcutList } from '../shortcuts/react';
import {
  CommandProvider,
  type CommandSpec,
  createCommandRegistry,
  useCommandList,
  useCommands,
} from './commands';

afterEach(cleanup);

describe('the command registry', () => {
  it('lists commands in the order they were registered, until they are removed', () => {
    const registry = createCommandRegistry();
    const offTheme = registry.register({ label: 'Switch theme', run: () => {} });
    registry.register({ label: 'Open Settings', run: () => {} });
    expect(registry.list().map((command) => command.label)).toEqual(['Switch theme', 'Open Settings']);
    offTheme();
    expect(registry.list().map((command) => command.label)).toEqual(['Open Settings']);
  });

  it('refuses a second command with the same name', () => {
    const registry = createCommandRegistry();
    registry.register({ label: 'New Todo', run: () => {} });
    expect(() => registry.register({ label: 'New Todo', run: () => {} })).toThrow(/already/);
  });

  it('leaves out a command whose `when` does not hold', () => {
    const registry = createCommandRegistry();
    let selected = false;
    registry.register({ label: 'Send to Linear', when: () => selected, run: () => {} });
    expect(registry.available()).toEqual([]);
    selected = true;
    expect(registry.available().map((command) => command.label)).toEqual(['Send to Linear']);
  });

  it('tells subscribers when the list changes', () => {
    const registry = createCommandRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.register({ label: 'Switch theme', run: () => {} })();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

function Registers({ commands }: { commands: CommandSpec[] }) {
  useCommands(commands);
  return null;
}

function Lists({ onList }: { onList: (labels: string[], keys: string[]) => void }) {
  const commands = useCommandList();
  const shortcuts = useShortcutList();
  onList(
    commands.map((command) => command.label),
    shortcuts.map((shortcut) => `${shortcut.keys.join('+')} ${shortcut.label}`),
  );
  return null;
}

describe('useCommands', () => {
  it('registers commands while mounted, and a command with keys as a shortcut too', () => {
    let labels: string[] = [];
    let keys: string[] = [];
    const run = vi.fn();
    const view = render(
      <ShortcutProvider>
        <CommandProvider>
          <Registers
            commands={[
              { label: 'Open Settings', keys: ',', group: 'General', run },
              { label: 'Switch theme', run: () => {} },
            ]}
          />
          <Lists
            onList={(l, k) => {
              labels = l;
              keys = k;
            }}
          />
        </CommandProvider>
      </ShortcutProvider>,
    );
    expect(labels).toEqual(['Open Settings', 'Switch theme']);
    expect(keys).toEqual([', Open Settings']);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ',' }));
    });
    expect(run).toHaveBeenCalledTimes(1);

    view.rerender(
      <ShortcutProvider>
        <CommandProvider>
          <Lists
            onList={(l, k) => {
              labels = l;
              keys = k;
            }}
          />
        </CommandProvider>
      </ShortcutProvider>,
    );
    expect(labels).toEqual([]);
    expect(keys).toEqual([]);
  });

  it('runs the latest handler', () => {
    const registry = createCommandRegistry();
    const first = vi.fn();
    const second = vi.fn();
    const view = render(
      <ShortcutProvider>
        <CommandProvider registry={registry}>
          <Registers commands={[{ label: 'Switch theme', run: first }]} />
        </CommandProvider>
      </ShortcutProvider>,
    );
    view.rerender(
      <ShortcutProvider>
        <CommandProvider registry={registry}>
          <Registers commands={[{ label: 'Switch theme', run: second }]} />
        </CommandProvider>
      </ShortcutProvider>,
    );
    registry.list()[0]?.run();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
