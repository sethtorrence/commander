// Colour maths shared by the signal colour and the Project accents (WCAG 2 relative luminance).

/** An sRGB colour as unrounded 0–255 channels, so repeated mixing doesn't drift. */
export type Rgb = readonly [number, number, number];

export const WHITE: Rgb = [255, 255, 255];
export const BLACK: Rgb = [0, 0, 0];

const HEX = /^#?([0-9a-f]{6})$/i;

/** `#RRGGBB` in upper case, or null if the text isn't a six-digit hex colour. */
export function normaliseHex(text: string): string | null {
  const match = HEX.exec(text.trim());
  return match ? `#${match[1]?.toUpperCase()}` : null;
}

export function hexToRgb(hex: string): Rgb {
  const normal = normaliseHex(hex);
  if (!normal) throw new Error(`Not a hex colour: ${hex}`);
  const n = Number.parseInt(normal.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const channel = (value: number) => Math.round(Math.max(0, Math.min(255, value)));

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((v) => channel(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

export function rgba(rgb: Rgb, alpha: number): string {
  return `rgba(${rgb.map(channel).join(',')},${alpha})`;
}

const toRgb = (colour: Rgb | string): Rgb => (typeof colour === 'string' ? hexToRgb(colour) : colour);

export function relativeLuminance(colour: Rgb | string): number {
  const [r, g, b] = toRgb(colour).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as unknown as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: Rgb | string, b: Rgb | string): number {
  const x = relativeLuminance(a);
  const y = relativeLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function toOklab(colour: Rgb | string): Rgb {
  const [r, g, b] = toRgb(colour).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as unknown as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Perceptual distance between two colours in OKLab (about 0.02 is just noticeable). */
export function oklabDistance(a: Rgb | string, b: Rgb | string): number {
  const x = toOklab(a);
  const y = toOklab(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** Move `colour` a fraction `amount` (0–1) of the way to `target`. */
export function mix(colour: Rgb, target: Rgb, amount: number): Rgb {
  return colour.map((v, i) => v + ((target[i] ?? v) - v) * amount) as unknown as Rgb;
}

/**
 * Nudge `colour` toward `target` in 1% steps until it reaches `min` contrast on `background`
 * (the round-3 picker's rule). Returns the colour unchanged if it already passes.
 */
export function nudgeToContrast(colour: Rgb, background: Rgb, target: Rgb, min: number): Rgb {
  let amount = 0;
  let out = colour;
  while (contrastRatio(out, background) < min && amount < 1) {
    amount += 0.01;
    out = mix(colour, target, amount);
  }
  return out;
}
