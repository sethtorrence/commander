import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  createShortcutRegistry,
  type ListedShortcut,
  type Shortcut,
  type ShortcutRegistry,
} from './registry';

/*
  React bindings for the shortcut registry (registry.ts explains the rules).

  - <ShortcutProvider> owns the registry and the one keydown listener. Mount it once, near the root.
  - useShortcuts([...]) registers keys for as long as the component is mounted. Handlers can change
    on every render; only a change of keys, labels or flags registers again.
  - <ShortcutScope scope group> sets the default scope and cheat-sheet group for everything inside.
    The frame wraps each Section in one (scope = the Section's id, group = its name), so a Section
    just calls useShortcuts and its keys work only while it is open:

      useShortcuts([{ keys: 'x', label: 'Tick a Todo', run: () => tick(selected) }]);

  - useActiveScopes([...]) says which scopes run (the frame passes the open Section).
  - useShortcutList() is everything registered, for the cheat sheet.
*/

const RegistryContext = createContext<ShortcutRegistry | null>(null);
const ScopeContext = createContext<{ scope?: string; group?: string }>({});

export function ShortcutProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(createShortcutRegistry);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => registry.handle(event);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [registry]);
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

export function useShortcutRegistry(): ShortcutRegistry {
  const registry = useContext(RegistryContext);
  if (!registry) throw new Error('Shortcuts need a <ShortcutProvider> above them');
  return registry;
}

export function ShortcutScope({
  scope,
  group,
  children,
}: {
  scope: string;
  group: string;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ scope, group }), [scope, group]);
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

/** A shortcut to register. `group` and `scope` default to the surrounding ShortcutScope (or app-wide, "General"). */
export type ShortcutSpec = Omit<Shortcut, 'group'> & { group?: string };

export function useShortcuts(shortcuts: readonly ShortcutSpec[]): void {
  const registry = useShortcutRegistry();
  const { scope, group } = useContext(ScopeContext);
  const latest = useRef(shortcuts);
  useLayoutEffect(() => {
    latest.current = shortcuts;
  });
  const signature = shortcuts
    .map((s) => [s.keys, s.label, s.group, s.scope, s.inFields, s.inDialogs, !!s.when].join('|'))
    .join('\n');

  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` stands for the shortcuts; handlers are read through `latest`
  useEffect(() => {
    const unregister = latest.current.map((shortcut, index) =>
      registry.register({
        ...shortcut,
        scope: shortcut.scope ?? scope,
        group: shortcut.group ?? group ?? 'General',
        when: shortcut.when && (() => latest.current[index]?.when?.() ?? false),
        run: (event) => latest.current[index]?.run(event),
      }),
    );
    return () => {
      for (const off of unregister) off();
    };
  }, [registry, scope, group, signature]);
}

export function useActiveScopes(scopes: readonly string[]): void {
  const registry = useShortcutRegistry();
  const key = scopes.join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the scopes
  useEffect(() => registry.setActiveScopes(scopes), [registry, key]);
}

export function useShortcutList(): readonly ListedShortcut[] {
  const registry = useShortcutRegistry();
  return useSyncExternalStore(registry.subscribe, registry.list);
}
