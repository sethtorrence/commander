// Project accent colours: the colour a Project's Badge sits on.
// Each accent is one base colour, nudged per theme (like the signal colour) until it reaches 3:1
// on the sheet. Accents appear only as Badges and thin left bars; the signal colour stays for live things.
import {
  BLACK,
  contrastRatio,
  hexToRgb,
  mix,
  normaliseHex,
  oklabDistance,
  type Rgb,
  rgbToHex,
  WHITE,
} from '../signal/colour';
import { DEFAULT_SIGNAL, deriveSignal, FILL_CONTRAST, TEXT_CONTRAST } from '../signal/signal';
import { DARK_TEXT, SHEET_COLOUR, THEMES, type Theme } from '../theme/themes';

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

const DARK_TEXT_RGB = hexToRgb(DARK_TEXT);

// The text a Badge on this fill gets: near-black or white, whichever contrasts more.
function textOn(fill: Rgb): Rgb {
  return contrastRatio(fill, DARK_TEXT_RGB) >= contrastRatio(fill, WHITE) ? DARK_TEXT_RGB : WHITE;
}

/**
 * An accent's fill on one theme's sheet: nudged in 1% steps (toward white on the dark sheet, black on
 * the light one) until it reaches 3:1 on the sheet and its Badge text reaches 4.5:1.
 */
function fillOn(base: Rgb, theme: Theme): Rgb {
  const sheet = hexToRgb(SHEET_COLOUR[theme]);
  const toward = theme === 'dark' ? WHITE : BLACK;
  const passes = (fill: Rgb) =>
    contrastRatio(fill, sheet) >= FILL_CONTRAST && contrastRatio(fill, textOn(fill)) >= TEXT_CONTRAST;
  let amount = 0;
  let fill = base;
  while (!passes(fill) && amount < 1) {
    amount += 0.01;
    fill = mix(base, toward, amount);
  }
  return fill;
}

function deriveAccent(name: AccentName): ProjectAccent {
  const base = hexToRgb(BASES[name]);
  return {
    name,
    base: BASES[name],
    dark: rgbToHex(fillOn(base, 'dark')),
    light: rgbToHex(fillOn(base, 'light')),
  };
}

export const PROJECT_ACCENTS: readonly ProjectAccent[] = ACCENT_NAMES.map(deriveAccent);

export function accentFor(name: string): ProjectAccent | undefined {
  return PROJECT_ACCENTS.find((accent) => accent.name === name);
}

/** How far (in OKLab) an accent must stay from international orange, which is kept for live things and Ares. */
export const ORANGE_DISTANCE = 0.18;
const ORANGE = deriveSignal(DEFAULT_SIGNAL);

/** A picked accent colour as each theme would show it, and whether it should be used. */
export interface AccentCheck {
  /** The colour picked, as #RRGGBB. */
  hex: string;
  /** The Badge fill on each theme's sheet, deepened until it reaches 3:1. */
  dark: string;
  light: string;
  /** The Badge text on each fill: near-black or white. */
  text: Record<Theme, string>;
  /** Each fill's contrast on its sheet. */
  contrast: Record<Theme, number>;
  /** True when either theme had to deepen the colour. */
  adjusted: boolean;
  /** True when it is close to international orange in either theme: warn, as orange is for live things and Ares. */
  nearOrange: boolean;
}

/**
 * Checks a custom accent with the signal colour's logic: per theme it is deepened until it reaches
 * 3:1 on the sheet (and its Badge text 4.5:1), and it is flagged when close to international orange.
 * Every palette colour passes unchanged.
 */
export function checkAccent(colour: string): AccentCheck {
  const hex = normaliseHex(colour);
  if (!hex) throw new Error(`Not a colour: ${colour}`);
  const base = hexToRgb(hex);
  const fills = { dark: fillOn(base, 'dark'), light: fillOn(base, 'light') };
  const shade = (theme: Theme) => rgbToHex(fills[theme]);
  return {
    hex,
    dark: shade('dark'),
    light: shade('light'),
    text: { dark: rgbToHex(textOn(fills.dark)), light: rgbToHex(textOn(fills.light)) },
    contrast: {
      dark: contrastRatio(fills.dark, SHEET_COLOUR.dark),
      light: contrastRatio(fills.light, SHEET_COLOUR.light),
    },
    adjusted: THEMES.some((theme) => shade(theme) !== hex),
    nearOrange: THEMES.some((theme) => oklabDistance(fills[theme], ORANGE[theme].fill) < ORANGE_DISTANCE),
  };
}

// A custom accent's shades in both themes, picked by the sheet's color-scheme (set per theme).
function custom(accent: string, pick: (check: AccentCheck) => Record<Theme, string>): string | undefined {
  if (!normaliseHex(accent)) return undefined;
  const shades = pick(checkAccent(accent));
  return `light-dark(${shades.light}, ${shades.dark})`;
}

/** The CSS colour for a Project accent: a palette accent's per-theme token, or a custom colour per theme. */
export function accentColour(accent: string): string {
  if (accentFor(accent)) return `var(--accent-${accent})`;
  return custom(accent, (check) => ({ dark: check.dark, light: check.light })) ?? accent;
}

/** The CSS colour of a Badge's text on a custom accent; undefined for a palette accent (it uses --on-accent). */
export function accentTextColour(accent: string): string | undefined {
  if (accentFor(accent)) return undefined;
  return custom(accent, (check) => check.text);
}
