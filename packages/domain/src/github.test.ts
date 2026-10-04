import { describe, expect, it } from 'vitest';
import { githubIdentifier, isRevert } from './github';
import { sourceCatalog } from './source-catalog';

describe('isRevert', () => {
  it('knows the usual revert wording', () => {
    expect(isRevert('Revert "Retry webhooks with back-off" (#212)')).toBe(true);
    expect(isRevert('revert: drop the cache')).toBe(true);
    expect(isRevert('Undo the cache\n\nThis reverts commit 0a1b2c3d4e5f.')).toBe(true);
  });

  it('leaves other commits alone', () => {
    expect(isRevert('Retry webhooks with back-off')).toBe(false);
    expect(isRevert('Reverting is hard: notes on rollbacks')).toBe(false);
  });
});

it('names a pull request or issue as people write it', () => {
  expect(githubIdentifier({ owner: 'acme-org', name: 'api' }, 212)).toBe('acme-org/api#212');
});

it('reads a Linear or a GitHub catalog', () => {
  expect(sourceCatalog.parse({ kind: 'github', repos: [] })).toEqual({ kind: 'github', repos: [] });
  expect(sourceCatalog.parse({ kind: 'linear', teams: [] })).toEqual({ kind: 'linear', teams: [] });
  expect(sourceCatalog.safeParse({ kind: 'gmail' }).success).toBe(false);
});
