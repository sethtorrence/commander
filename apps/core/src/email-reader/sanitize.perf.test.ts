import { expect, it } from 'vitest';
import { type SanitizeOptions, sanitizeEmailHtml, TooComplex } from './sanitize';

// Speed checks for the sanitiser, run by `pnpm test:perf` one file at a time (see vitest.perf.config.ts)
// so other work on the machine can't fail them. Pathological input from any sender must never stall
// the Core.

const run = (html: string, overrides: Partial<SanitizeOptions> = {}) =>
  sanitizeEmailHtml(html, {
    images: 'held',
    quotes: true,
    imageUrl: (index) => `commander-mail://image/T/${index}`,
    partUrl: (contentId) => `commander-mail://part/T/${encodeURIComponent(contentId)}`,
    ...overrides,
  });

// Pathological input from any sender must never stall the Core (each takes well under a second;
// the budgets leave room for a loaded machine).
const quick = (label: string, html: string, budgetMs = 3000) =>
  it(`deals quickly with ${label}`, () => {
    const started = performance.now();
    try {
      run(html, { quotes: false });
    } catch (error) {
      expect(error).toBeInstanceOf(TooComplex);
    }
    expect(performance.now() - started).toBeLessThan(budgetMs);
  });
quick('stray closing tags hiding deep nesting', '<div></x>'.repeat(16000));
quick('a tag that never closes, repeated', '<a '.repeat(333000));
quick('a very long tag name with no end', `<a${'b'.repeat(1_000_000)}`);
quick('thousands of quote candidates', 'x<div class=gmail_quote></div>'.repeat(8000));
quick('many unclosed paragraphs and cells', '<p>x<td>y<li>z'.repeat(50000), 8000);
