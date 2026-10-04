import type { Item } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { buildPrompt } from '../agent/prompt';
import { blankCredentials } from './credentials';
import { cleanModelText, stripInternalWording } from './output';
import { findSteering } from './steering';
import { foldForMatching, normalise } from './text';

// Outside text is written by whoever sent it, so every pattern that reads it must stay fast on
// crafted input: none may backtrack its way into seconds (which would stall the Core). Each check
// gets 100k characters built to make a careless pattern go quadratic.

const N = 100_000;
const fill = (unit: string) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);

const CRAFTED: [string, string][] = [
  ['a keyword then spaces', `password${' '.repeat(N)}`],
  ['a keyword, spaces and a quote', `api_key${' '.repeat(N / 2)}"${' '.repeat(N / 2)}`],
  ['a long URL scheme', `${fill('a.')}://`],
  ['userinfo with no @', `x://${fill('a:')}`],
  ['image openings', fill('![')],
  ['link openings', fill('[a](')],
  ['brackets', fill('[')],
  ['JWT-looking runs', fill('eyJaaaaaaaaaa-')],
  ['bearer words', fill('Bearer ')],
  ['authorization and spaces', `authorization${' '.repeat(N)}`],
  ['tag openings', fill('< ')],
  ['quotes and stops', fill('". ')],
  ['repeated schemes', fill('http://')],
  ['a SendGrid-looking run', `SG.${fill('a')}`],
  ['private key headers', fill('-----BEGIN A ')],
  ['steering words', fill('ignore all your previous ')],
  ['addresses to Ares', fill('ares, please ')],
  ['emphasis markers', fill('*a ')],
  ['a random-looking run', fill('aB3')],
];

// The best of two timed runs, after a warm-up, in milliseconds.
function timed(run: () => unknown): number {
  run();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 2; i++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

const outside = {
  id: 'issue',
  kind: 'linear-issue',
  source: 'linear',
  account: 'acme',
  externalId: 'x',
  title: 't',
  people: [],
  filing: null,
  status: 'open',
  detail: null,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
} satisfies Item;

describe.each(CRAFTED)('on crafted input (%s)', (_name, text) => {
  it.each<[string, (text: string) => unknown]>([
    ['normalise', normalise],
    ['foldForMatching', foldForMatching],
    ['blankCredentials', blankCredentials],
    ['findSteering', findSteering],
    ['stripInternalWording', (t) => stripInternalWording(t, t)],
    ['cleanModelText', (t) => cleanModelText(t, t)],
    ['buildPrompt', (t) => buildPrompt({ instructions: 'x', data: [{ label: t, from: outside, text: t }] })],
  ])('%s stays fast', (_fn, run) => {
    expect(timed(() => run(text))).toBeLessThan(50);
  });
});
