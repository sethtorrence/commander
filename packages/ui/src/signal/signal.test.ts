import { describe, expect, it } from 'vitest';
import { contrastRatio } from './colour';
import { DEFAULT_SIGNAL, deriveSignal, parseSignalHex, SIGNAL_PRESETS, signalCss } from './signal';

const SHEET = { dark: '#1B1C1E', light: '#E9E7E2' } as const;

describe('contrastRatio', () => {
  it('is 21:1 for black on white and 1:1 for a colour on itself', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FF5F00', '#FF5F00')).toBe(1);
  });
});

describe('parseSignalHex', () => {
  it('accepts six-digit hex with or without # and normalises it', () => {
    expect(parseSignalHex('ff5f00')).toBe('#FF5F00');
    expect(parseSignalHex('#00e676')).toBe('#00E676');
  });

  it('rejects anything else', () => {
    expect(parseSignalHex('orange')).toBeNull();
    expect(parseSignalHex('#FFF')).toBeNull();
    expect(parseSignalHex('')).toBeNull();
  });
});

describe('deriveSignal', () => {
  it('defaults to international orange', () => {
    expect(DEFAULT_SIGNAL).toBe('#FF5F00');
  });

  it('gives the locked shades for international orange', () => {
    const orange = deriveSignal('#FF5F00');
    expect(orange.dark).toMatchObject({ fill: '#FF5F00', ink: '#FF5F00', onFill: '#141414' });
    expect(orange.light).toMatchObject({ fill: '#E65600', ink: '#B24200', onFill: '#141414' });
  });

  it('reports the contrast figures from the decision ticket', () => {
    const { dark, light } = deriveSignal('#FF5F00');
    expect(dark.fillContrast.toFixed(1)).toBe('5.6');
    expect(dark.onFillContrast.toFixed(1)).toBe('6.0');
    expect(light.fillContrast.toFixed(1)).toBe('3.0');
    expect(light.onFillContrast.toFixed(1)).toBe('5.0');
    expect(light.inkContrast.toFixed(1)).toBe('4.6');
  });

  it('only marks a theme adjusted when the fill had to move', () => {
    const { dark, light } = deriveSignal('#FF5F00');
    expect(dark.adjusted).toBe(false);
    expect(light.adjusted).toBe(true);
  });

  it('gives the shades recorded for phosphor green', () => {
    const green = deriveSignal('#00E676');
    expect(green.dark).toMatchObject({ fill: '#00E676', ink: '#00E676', onFill: '#141414' });
    expect(green.light).toMatchObject({ fill: '#00984E', ink: '#00783D', onFill: '#141414' });
  });

  it('derives the translucent shades from the fill', () => {
    const { dark, light } = deriveSignal('#FF5F00');
    expect(dark).toMatchObject({
      soft: 'rgba(255,95,0,0.14)',
      focus: 'rgba(255,95,0,0.06)',
      selection: 'rgba(255,95,0,0.32)',
    });
    expect(light).toMatchObject({
      soft: 'rgba(230,86,0,0.13)',
      focus: 'rgba(230,86,0,0.075)',
      selection: 'rgba(230,86,0,0.28)',
    });
  });

  it.each([
    ...SIGNAL_PRESETS.map((preset) => preset.hex),
    '#FFFFFF',
    '#000000',
    '#777777',
    '#1B1C1E',
    '#E9E7E2',
  ])('keeps %s visible on both sheets', (hex) => {
    const signal = deriveSignal(hex);
    for (const theme of ['dark', 'light'] as const) {
      const shades = signal[theme];
      expect(contrastRatio(shades.fill, SHEET[theme])).toBeGreaterThanOrEqual(2.95);
      expect(shades.fillContrast).toBeGreaterThanOrEqual(3);
      expect(shades.inkContrast).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(SIGNAL_PRESETS.map((preset) => preset.hex))(
    'puts black or white text on the %s fill, whichever contrasts more',
    (hex) => {
      const signal = deriveSignal(hex);
      for (const shades of [signal.dark, signal.light]) {
        const other = shades.onFill === '#141414' ? '#FFFFFF' : '#141414';
        expect(['#141414', '#FFFFFF']).toContain(shades.onFill);
        expect(contrastRatio(shades.fill, shades.onFill)).toBeGreaterThanOrEqual(
          contrastRatio(shades.fill, other),
        );
      }
    },
  );

  it('picks white text on a dark fill', () => {
    expect(deriveSignal('#2F6BFF').light.onFill).toBe('#FFFFFF');
  });

  it('throws on a colour it cannot read', () => {
    expect(() => deriveSignal('nope')).toThrow(/signal colour/i);
  });
});

describe('signalCss', () => {
  it('writes every signal variable for both themes', () => {
    const css = signalCss(deriveSignal('#FF5F00'));
    expect(css).toContain(
      '[data-theme=dark]{--signal:#FF5F00;--on-signal:#141414;--signal-ink:#FF5F00;--signal-soft:rgba(255,95,0,0.14);--signal-focus:rgba(255,95,0,0.06);--signal-sel:rgba(255,95,0,0.32)}',
    );
    expect(css).toContain(
      '[data-theme=light]{--signal:#E65600;--on-signal:#141414;--signal-ink:#B24200;--signal-soft:rgba(230,86,0,0.13);--signal-focus:rgba(230,86,0,0.075);--signal-sel:rgba(230,86,0,0.28)}',
    );
  });
});
