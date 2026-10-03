// Project accent colours: the colour a Project's Badge sits on.
// Each accent is one base colour, nudged per theme (like the signal colour) until it reaches 3:1
// on the sheet. Accents appear only as Badges and thin left bars; the signal colour stays for live things.
import { BLACK, hexToRgb, nudgeToContrast, rgbToHex, WHITE } from '../signal/colour';
import { FILL_CONTRAST } from '../signal/signal';
import { SHEET_COLOUR } from '../theme/themes';

export const ACCENT_NAMES = ['blue', 'teal', 'violet', 'magenta', 'green', 'sky', 'lime', 'slate'] as const;
export type AccentName = (typeof ACCENT_NAMES)[number];

export interface ProjectAccent {
  name: AccentName;
  base: string;
  dark: string;
  light: string;
}

const BASES: Record<AccentName, string> = {
  blue: '#3D7BFF',
  teal: '#00BFA5',
  violet: '#A970FF',
  magenta: '#F03CA8',
  green: '#2FBF4F',
  sky: '#26B8E8',
  lime: '#B5C800',
  slate: '#A3A9B5',
};

function deriveAccent(name: AccentName): ProjectAccent {
  const base = hexToRgb(BASES[name]);
  const onDark = nudgeToContrast(base, hexToRgb(SHEET_COLOUR.dark), WHITE, FILL_CONTRAST);
  const onLight = nudgeToContrast(base, hexToRgb(SHEET_COLOUR.light), BLACK, FILL_CONTRAST);
  return { name, base: BASES[name], dark: rgbToHex(onDark), light: rgbToHex(onLight) };
}

export const PROJECT_ACCENTS: readonly ProjectAccent[] = ACCENT_NAMES.map(deriveAccent);

export function accentFor(name: string): ProjectAccent | undefined {
  return PROJECT_ACCENTS.find((accent) => accent.name === name);
}

/** The CSS colour for a Project accent: a palette accent's per-theme token, or a custom colour as is. */
export function accentColour(accent: string): string {
  return accentFor(accent) ? `var(--accent-${accent})` : accent;
}
