// The User's appearance settings: the theme and the signal colour.
// Kept in localStorage for now; they move into the User's settings once the Core stores them.
import { DEFAULT_SIGNAL, parseSignalHex } from '../signal/signal';
import { DEFAULT_THEME, isTheme, type Theme } from './themes';

export interface Appearance {
  theme: Theme;
  signal: string;
}

export const STORAGE_KEYS = {
  theme: 'commander.appearance.theme',
  signal: 'commander.appearance.signal',
} as const;

function read(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function loadAppearance(storage: Storage): Appearance {
  const theme = read(storage, STORAGE_KEYS.theme);
  const signal = parseSignalHex(read(storage, STORAGE_KEYS.signal) ?? '');
  return { theme: isTheme(theme) ? theme : DEFAULT_THEME, signal: signal ?? DEFAULT_SIGNAL };
}

export function saveAppearance(storage: Storage, appearance: Appearance): void {
  try {
    storage.setItem(STORAGE_KEYS.theme, appearance.theme);
    storage.setItem(STORAGE_KEYS.signal, appearance.signal);
  } catch {
    // Storage full or unavailable: the setting still applies for this session.
  }
}
