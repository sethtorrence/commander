import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import { DEFAULT_SIGNAL, deriveSignal, parseSignalHex, type Signal, signalCss } from '../signal/signal';
import { type Appearance, loadAppearance, saveAppearance } from './appearance';
import type { Theme } from './themes';

const STYLE_ID = 'commander-signal';

export interface AppearanceApi {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  /** The picked signal colour and every shade derived from it, per theme. */
  signal: Signal;
  /** Recolours everything live; ignores text that isn't a six-digit hex colour. */
  setSignal: (hex: string) => void;
  resetSignal: () => void;
}

const AppearanceContext = createContext<AppearanceApi | null>(null);

function applySignal(signal: Signal) {
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.append(style);
  }
  style.textContent = signalCss(signal);
}

/** Holds the theme and signal colour, applies them to the document and remembers them. */
export function AppearanceProvider({ children, storage }: { children: ReactNode; storage?: Storage }) {
  const store = storage ?? globalThis.localStorage;
  const [appearance, setAppearance] = useState<Appearance>(() => loadAppearance(store));
  const signal = useMemo(() => deriveSignal(appearance.signal), [appearance.signal]);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = appearance.theme;
    applySignal(signal);
    saveAppearance(store, appearance);
  }, [appearance, signal, store]);

  const setTheme = useCallback((theme: Theme) => setAppearance((a) => ({ ...a, theme })), []);
  const toggleTheme = useCallback(
    () => setAppearance((a) => ({ ...a, theme: a.theme === 'dark' ? 'light' : 'dark' })),
    [],
  );
  const setSignal = useCallback((hex: string) => {
    const parsed = parseSignalHex(hex);
    if (parsed) setAppearance((a) => ({ ...a, signal: parsed }));
  }, []);
  const resetSignal = useCallback(() => setAppearance((a) => ({ ...a, signal: DEFAULT_SIGNAL })), []);

  const api = useMemo(
    () => ({ theme: appearance.theme, setTheme, toggleTheme, signal, setSignal, resetSignal }),
    [appearance.theme, setTheme, toggleTheme, signal, setSignal, resetSignal],
  );
  return <AppearanceContext.Provider value={api}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceApi {
  const api = useContext(AppearanceContext);
  if (!api) throw new Error('useAppearance needs an <AppearanceProvider> above it');
  return api;
}
