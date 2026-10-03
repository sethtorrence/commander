// The signal colour: one picked colour, from which every signal shade is derived per theme.
// Ported from the round-3 picker prototype (prototype/daily-note-look, round-3/industrial.html).
import { DARK_TEXT, SHEET_COLOUR, THEMES, type Theme } from '../theme/themes';
import {
  BLACK,
  contrastRatio,
  hexToRgb,
  normaliseHex,
  nudgeToContrast,
  type Rgb,
  rgba,
  rgbToHex,
  WHITE,
} from './colour';

export const DEFAULT_SIGNAL = '#FF5F00';

/** Lines and fills must reach this on the sheet. */
export const FILL_CONTRAST = 3;
/** Coloured text must reach this on the sheet (WCAG AA). */
export const TEXT_CONTRAST = 4.5;

/** The swatches offered by the signal colour setting (the round-3 picker presets). */
export const SIGNAL_PRESETS = [
  { name: 'International orange', hex: '#FF5F00' },
  { name: 'Hazard amber', hex: '#FFA400' },
  { name: 'Safety yellow', hex: '#FFD100' },
  { name: 'Signal red', hex: '#FF2A1F' },
  { name: 'Magenta', hex: '#FF2D95' },
  { name: 'Ultraviolet', hex: '#8B5CFF' },
  { name: 'Cobalt', hex: '#2F6BFF' },
  { name: 'Electric cyan', hex: '#00D2FF' },
  { name: 'Phosphor green', hex: '#00E676' },
  { name: 'Acid green', hex: '#B8FF00' },
] as const;

export interface SignalShades {
  /** Fills and lines: nudged until 3:1 on the sheet. */
  fill: string;
  /** Text on the fill: near-black or white, whichever contrasts more. */
  onFill: string;
  /** Coloured text on the sheet: nudged until 4.5:1. */
  ink: string;
  soft: string;
  focus: string;
  selection: string;
  fillContrast: number;
  onFillContrast: number;
  inkContrast: number;
  /** True when the fill differs from the picked colour. */
  adjusted: boolean;
}

export interface Signal {
  hex: string;
  dark: SignalShades;
  light: SignalShades;
}

const DARK_TEXT_RGB = hexToRgb(DARK_TEXT);

// Translucent washes per theme, from the prototype: soft highlight, focused row, text selection.
const ALPHAS: Record<Theme, { soft: number; focus: number; selection: number }> = {
  dark: { soft: 0.14, focus: 0.06, selection: 0.32 },
  light: { soft: 0.13, focus: 0.075, selection: 0.28 },
};

export function parseSignalHex(text: string): string | null {
  return normaliseHex(text);
}

function shadesFor(picked: Rgb, theme: Theme): SignalShades {
  const sheet = hexToRgb(SHEET_COLOUR[theme]);
  // Dark theme brightens toward white, light theme deepens toward black.
  const toward = theme === 'dark' ? WHITE : BLACK;
  const fill = nudgeToContrast(picked, sheet, toward, FILL_CONTRAST);
  const ink = nudgeToContrast(picked, sheet, toward, TEXT_CONTRAST);
  const onFill = contrastRatio(fill, DARK_TEXT_RGB) >= contrastRatio(fill, WHITE) ? DARK_TEXT_RGB : WHITE;
  const alpha = ALPHAS[theme];
  return {
    fill: rgbToHex(fill),
    onFill: rgbToHex(onFill),
    ink: rgbToHex(ink),
    soft: rgba(fill, alpha.soft),
    focus: rgba(fill, alpha.focus),
    selection: rgba(fill, alpha.selection),
    fillContrast: contrastRatio(fill, sheet),
    onFillContrast: contrastRatio(fill, onFill),
    inkContrast: contrastRatio(ink, sheet),
    adjusted: rgbToHex(fill) !== rgbToHex(picked),
  };
}

export function deriveSignal(hex: string): Signal {
  const normal = normaliseHex(hex);
  if (!normal) throw new Error(`Not a signal colour: ${hex}`);
  const picked = hexToRgb(normal);
  return { hex: normal, dark: shadesFor(picked, 'dark'), light: shadesFor(picked, 'light') };
}

/** CSS that sets every signal variable for both themes. */
export function signalCss(signal: Signal): string {
  return THEMES.map((theme) => {
    const s = signal[theme];
    return (
      `[data-theme=${theme}]{--signal:${s.fill};--on-signal:${s.onFill};--signal-ink:${s.ink};` +
      `--signal-soft:${s.soft};--signal-focus:${s.focus};--signal-sel:${s.selection}}`
    );
  }).join('\n');
}
