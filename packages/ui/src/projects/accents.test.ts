import { describe, expect, it } from 'vitest';
import { contrastRatio, oklabDistance } from '../signal/colour';
import { deriveSignal } from '../signal/signal';
import { DARK_TEXT, SHEET_COLOUR, THEMES } from '../theme/themes';
import { accentFor, PROJECT_ACCENTS } from './accents';

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
