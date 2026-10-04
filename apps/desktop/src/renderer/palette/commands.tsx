import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { type ShortcutSpec, useShortcuts } from '../shortcuts/react';

/*
  The palette's commands: named things to do, run from Ctrl+K ("Switch theme", "Open Settings",
  "Sync Linear now"). Any component registers its own with useCommands, the way it registers keys
  with useShortcuts, and they last while it is mounted; a Section's commands work from anywhere.

  A command with `keys` is a shortcut too: useCommands registers it with the shortcut layer, so the
  key, the `?` cheat sheet and the palette row all come from the one place.

    useCommands([{ label: 'Open Settings', keys: ',', group: 'General', run: openSettings }]);
*/

export interface Command {
  /** Its name in the palette, unique: "Switch theme". */
  label: string;
  /** Its shortcut, as the shortcut layer writes it (",", "p o"), shown on its row. */
  keys?: string;
  /** Offered only while this holds (a Todo is selected, a Linear Account is connected). */
  when?: () => boolean;
  run: () => void;
}

export interface CommandRegistry {
  /** Adds a command; returns the function that removes it. */
  register(command: Command): () => void;
  /** Every registered command, in registration order. The same array until something changes. */
  list(): readonly Command[];
  /** The commands whose `when` holds right now. */
  available(): Command[];
  subscribe(listener: () => void): () => void;
}

export function createCommandRegistry(): CommandRegistry {
  let commands: readonly Command[] = [];
  const listeners = new Set<() => void>();
  const changed = (next: readonly Command[]) => {
    commands = next;
    for (const listener of listeners) listener();
  };
  return {
    register(command) {
      const taken = commands.find((c) => c.label === command.label);
      if (taken) throw new Error(`There is already a command called "${command.label}"`);
      changed([...commands, command]);
      return () => {
        if (commands.includes(command)) changed(commands.filter((c) => c !== command));
      };
    },
    list: () => commands,
    available: () => commands.filter((command) => command.when?.() ?? true),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const CommandContext = createContext<CommandRegistry | null>(null);

/** Holds the command registry for everything inside. Mount it once, inside the ShortcutProvider. */
export function CommandProvider({ registry, children }: { registry?: CommandRegistry; children: ReactNode }) {
  const [own] = useState(createCommandRegistry);
  return <CommandContext.Provider value={registry ?? own}>{children}</CommandContext.Provider>;
}

function useCommandRegistry(): CommandRegistry {
  const registry = useContext(CommandContext);
  if (!registry) throw new Error('Commands need a <CommandProvider> above them');
  return registry;
}

/**
 * A command to register. With `keys`, the shortcut options apply too (`group` is its cheat-sheet
 * heading, and the shortcut gets the surrounding scope like any other).
 */
export type CommandSpec = Command & Omit<ShortcutSpec, 'keys' | 'label' | 'run' | 'when'>;

/** Registers commands while the caller is mounted. Outside a CommandProvider (a component test) only their keys. */
export function useCommands(commands: readonly CommandSpec[]): void {
  const registry = useContext(CommandContext);
  const latest = useRef(commands);
  useLayoutEffect(() => {
    latest.current = commands;
  });
  const signature = commands.map((c) => [c.label, c.keys, !!c.when].join('|')).join('\n');

  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` stands for the commands; handlers are read through `latest`
  useEffect(() => {
    if (!registry) return;
    const unregister = latest.current.map((command, index) =>
      registry.register({
        label: command.label,
        keys: command.keys,
        when: command.when && (() => latest.current[index]?.when?.() ?? false),
        run: () => latest.current[index]?.run(),
      }),
    );
    return () => {
      for (const off of unregister) off();
    };
  }, [registry, signature]);

  useShortcuts(
    commands.flatMap(({ keys, label, run, when, ...options }) =>
      keys ? [{ ...options, keys, label, when, run: () => run() }] : [],
    ),
  );
}

/** Every registered command, for the palette. */
export function useCommandList(): readonly Command[] {
  const registry = useCommandRegistry();
  return useSyncExternalStore(registry.subscribe, registry.list);
}

/** The registry itself, for reading `available()` when the palette opens. */
export { useCommandRegistry };
