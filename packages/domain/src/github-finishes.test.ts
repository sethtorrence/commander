import { describe, expect, it } from 'vitest';
import { closingIssueRefs, linearIdentifiersIn } from './github-finishes';

// What a pull request names (#119): the Linear issues it finishes, by identifier, and the GitHub
// issues it closes, by GitHub's closing keywords. Matching against the Linear issues Commander holds
// happens where they are (the Core); these only read text.

describe('linearIdentifiersIn', () => {
  it('finds identifiers in a title, a body or a Linear link, upper-cased, once each', () => {
    expect(linearIdentifiersIn('ENG-412: retry webhooks')).toEqual(['ENG-412']);
    expect(linearIdentifiersIn('Retries failed deliveries.\n\nFixes ENG-412 and closes OPS-7.')).toEqual([
      'ENG-412',
      'OPS-7',
    ]);
    expect(linearIdentifiersIn('See https://linear.app/acme/issue/ENG-412/retry-webhooks')).toEqual([
      'ENG-412',
    ]);
    expect(linearIdentifiersIn('ENG-412 (again: ENG-412)')).toEqual(['ENG-412']);
  });

  it('finds them in a branch name, as Linear writes branches (lower case)', () => {
    expect(linearIdentifiersIn('priya/eng-412-retry-webhooks')).toEqual(['ENG-412']);
    expect(linearIdentifiersIn('eng-412')).toEqual(['ENG-412']);
    expect(linearIdentifiersIn('feature/ENG-412_retry')).toEqual(['ENG-412']);
  });

  it('takes every closing magic word Linear knows', () => {
    for (const word of [
      'close',
      'closes',
      'closed',
      'closing',
      'fix',
      'fixes',
      'fixed',
      'fixing',
      'resolve',
      'resolves',
      'resolved',
      'resolving',
      'complete',
      'completes',
      'completed',
      'completing',
    ])
      expect(linearIdentifiersIn(`${word} ENG-412`), word).toEqual(['ENG-412']);
  });

  it('leaves out identifiers only referred to (Linear’s non-closing magic words)', () => {
    for (const text of [
      'Part of ENG-412',
      'part of: ENG-412',
      'Related to ENG-412',
      'Contributes to ENG-412',
      'Toward ENG-412',
      'towards ENG-412',
      'Ref ENG-412',
      'refs ENG-412',
      'References ENG-412',
    ])
      expect(linearIdentifiersIn(text), text).toEqual([]);
    expect(linearIdentifiersIn('Part of ENG-1. Fixes ENG-2')).toEqual(['ENG-2']);
  });

  it('finds look-alikes too, which only the Linear issues Commander holds can confirm', () => {
    // utf-8 finishes something only where a Linear team's key is UTF.
    expect(linearIdentifiersIn('utf-8 and sha-256 with x-0')).toEqual(['UTF-8', 'SHA-256', 'X-0']);
    expect(linearIdentifiersIn('ENG412, -412, ENG-, 12-34')).toEqual([]);
  });
});

describe('closingIssueRefs', () => {
  const repo = { owner: 'acme', name: 'api' };

  it('reads every GitHub closing keyword, in any case, with or without a colon', () => {
    for (const word of [
      'close',
      'closes',
      'closed',
      'fix',
      'fixes',
      'fixed',
      'resolve',
      'resolves',
      'resolved',
    ])
      for (const form of [
        `${word} #30`,
        `${word.toUpperCase()} #30`,
        `${word}: #30`,
        `${word[0]?.toUpperCase()}${word.slice(1)}:#30`,
      ])
        expect(closingIssueRefs(form, repo), form).toEqual([{ owner: 'acme', name: 'api', number: 30 }]);
  });

  it('reads issues in other repos, by name or by link', () => {
    expect(closingIssueRefs('Fixes acme-org/web#45', repo)).toEqual([
      { owner: 'acme-org', name: 'web', number: 45 },
    ]);
    expect(closingIssueRefs('Closes https://github.com/acme/docs/issues/9', repo)).toEqual([
      { owner: 'acme', name: 'docs', number: 9 },
    ]);
  });

  it('reads several, once each, each with its own keyword', () => {
    expect(closingIssueRefs('Fixes #1, fixes #2 and resolves acme/api#1.\nAlso see #3.', repo)).toEqual([
      { owner: 'acme', name: 'api', number: 1 },
      { owner: 'acme', name: 'api', number: 2 },
    ]);
  });

  it('ignores mentions without a keyword, and keywords inside other words', () => {
    expect(closingIssueRefs('See #30. Prefix #31. Unfixed #32. hotfix #33', repo)).toEqual([]);
  });
});
