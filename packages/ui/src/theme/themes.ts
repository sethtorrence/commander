export const THEMES = ['dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = 'dark';

/** The sheet colour of each theme (graphite and concrete): everything coloured is measured against it. */
export const SHEET_COLOUR: Record<Theme, string> = { dark: '#1B1C1E', light: '#E9E7E2' };

/** Near-black used for text on a coloured fill (signal fill, Badges). */
export const DARK_TEXT = '#141414';

export function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light';
}
