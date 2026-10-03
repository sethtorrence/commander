import { describe, expect, it } from 'vitest';
import { contrastRatio, oklabDistance } from '../signal/colour';
import { deriveSignal } from '../signal/signal';
import { DARK_TEXT, SHEET_COLOUR, THEMES } from '../theme/themes';
import { accentColour, accentFor, accentTextColour, checkAccent, PROJECT_ACCENTS } from './accents';

const orange = deriveSignal('#FF5F00');

describe('Project accent palette', () => {
  it('has eight accents with unique names', () => {
    expect(PROJECT_ACCENTS).toHaveLength(8);
    expect(new Set(PROJECT_ACCENTS.map((a) => a.name)).size).toBe(8);
  });

  it('keeps the accents verified in the Dashboard decision', () => {
    expect(accentFor('blue')).toMatchObject({ dark: '#3D7BFF', light: '#3D7BFF' });
    expect(accentFor('teal')).toMatchObject({ dark: '#00BFA5', light: '#009581' });
    expect(accentFor('violet')).toMatchObject({ dark: '#A970FF', light: '#9D68ED' });
  });

  describe.each(THEMES)('in the %s theme', (theme) => {
    it.each(PROJECT_ACCENTS.map((a) => [a.name, a] as const))(
      '%s reaches 3:1 on the sheet and carries Badge text at 4.5:1',
      (_name, accent) => {
        expect(contrastRatio(accent[theme], SHEET_COLOUR[theme])).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(accent[theme], DARK_TEXT)).toBeGreaterThanOrEqual(4.5);
      },
    );

    it.each(PROJECT_ACCENTS.map((a) => [a.name, a] as const))('%s stays clear of orange', (_name, accent) => {
      expect(oklabDistance(accent[theme], orange[theme].fill)).toBeGreaterThanOrEqual(0.18);
    });

    it('keeps every pair of accents apart', () => {
      for (const [i, a] of PROJECT_ACCENTS.entries()) {
        for (const b of PROJECT_ACCENTS.slice(i + 1)) {
          expect(oklabDistance(a[theme], b[theme]), `${a.name} vs ${b.name}`).toBeGreaterThanOrEqual(0.08);
        }
      }
    });
  });

  it('falls back to no accent for an unknown name', () => {
    expect(accentFor('mauve')).toBeUndefined();
  });
});

describe('checking a custom accent', () => {
  it.each(PROJECT_ACCENTS.map((a) => [a.name, a] as const))(
    'passes palette colour %s unchanged from its palette shades, with no warning',
    (_name, accent) => {
      const check = checkAccent(accent.base);
      expect(check).toMatchObject({ dark: accent.dark, light: accent.light, nearOrange: false });
    },
  );

  it('keeps a colour that already reaches 3:1 in both themes as it is', () => {
    expect(checkAccent('#3d7bff')).toMatchObject({
      hex: '#3D7BFF',
      dark: '#3D7BFF',
      light: '#3D7BFF',
      adjusted: false,
    });
  });

  describe.each(THEMES)('in the %s theme', (theme) => {
    it.each(['#202124', '#2A2A40', '#E0E0D8', '#F2F0A0', '#808080', '#00FF00'])(
      'deepens %s until it reaches 3:1 on the sheet, with legible Badge text',
      (hex) => {
        const check = checkAccent(hex);
        expect(contrastRatio(check[theme], SHEET_COLOUR[theme])).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(check[theme], check.text[theme])).toBeGreaterThanOrEqual(4.5);
        expect(check.contrast[theme]).toBeGreaterThanOrEqual(3);
      },
    );
  });

  it('says when it had to adjust the colour', () => {
    expect(checkAccent('#202124').adjusted).toBe(true);
    expect(checkAccent('#E0E0D8').adjusted).toBe(true);
  });

  it.each(['#FF5F00', '#FF7A1A', '#E65600', '#FF4D10', '#FF8C00'])(
    'warns that %s is close to orange',
    (hex) => {
      expect(checkAccent(hex).nearOrange).toBe(true);
    },
  );

  it.each(['#3D7BFF', '#00BFA5', '#F03CA8', '#2FBF4F', '#A3A9B5'])('does not warn about %s', (hex) => {
    expect(checkAccent(hex).nearOrange).toBe(false);
  });

  it('refuses text that is not a colour', () => {
    expect(() => checkAccent('blue!')).toThrow('Not a colour');
  });
});

describe('the CSS for an accent', () => {
  it('uses the theme token for a palette accent', () => {
    expect(accentColour('teal')).toBe('var(--accent-teal)');
    expect(accentTextColour('teal')).toBeUndefined();
  });

  it('gives a custom accent its own shade and Badge text in each theme', () => {
    const check = checkAccent('#202124');
    expect(accentColour('#202124')).toBe(`light-dark(${check.light}, ${check.dark})`);
    expect(accentTextColour('#202124')).toBe(`light-dark(${check.text.light}, ${check.text.dark})`);
  });
});
