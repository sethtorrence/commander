import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROJECT_ACCENTS } from '../projects/accents';
import { DEFAULT_SIGNAL, deriveSignal } from '../signal/signal';
import { SHEET_COLOUR, THEMES, type Theme } from '../theme/themes';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

/** The custom properties declared in the rule whose selector list ends with this theme's selector. */
function themeVariables(theme: Theme): Map<string, string> {
  const rule = new RegExp(`\\[data-theme=["']?${theme}["']?\\]\\s*\\{([^}]*)\\}`).exec(css);
  if (!rule?.[1]) throw new Error(`No rule for the ${theme} theme in tokens.css`);
  const vars = new Map<string, string>();
  for (const [, name, value] of rule[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (name && value) vars.set(name, value.replace(/\s+/g, '').toUpperCase());
  }
  return vars;
}

const signal = deriveSignal(DEFAULT_SIGNAL);

describe.each(THEMES)('tokens.css, %s theme', (theme) => {
  const vars = themeVariables(theme);

  it('uses the theme sheet colour the derivation measures against', () => {
    expect(vars.get('--sheet')).toBe(SHEET_COLOUR[theme].toUpperCase());
  });

  it('ships the derived shades of the default signal colour', () => {
    const shades = signal[theme];
    expect(vars.get('--signal')).toBe(shades.fill);
    expect(vars.get('--on-signal')).toBe(shades.onFill);
    expect(vars.get('--signal-ink')).toBe(shades.ink);
    expect(vars.get('--signal-soft')).toBe(shades.soft.toUpperCase());
    expect(vars.get('--signal-focus')).toBe(shades.focus.toUpperCase());
    expect(vars.get('--signal-sel')).toBe(shades.selection.toUpperCase());
  });

  it('ships every Project accent as derived', () => {
    for (const accent of PROJECT_ACCENTS) {
      expect(vars.get(`--accent-${accent.name}`), accent.name).toBe(accent[theme]);
    }
  });
});
