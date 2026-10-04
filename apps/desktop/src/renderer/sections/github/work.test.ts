import type { Item, Person, SourceItem } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { lookupOf } from '../../people/people';
import { DOTFILES, GITHUB, issue, NOW, pull, WEB } from './test-work';
import {
  ageOf,
  filterOptions,
  groupWork,
  identifierOf,
  inFilters,
  inView,
  isPullRequest,
  linkedWork,
  NO_FILTERS,
  reviewersOf,
  stateOf,
  toWork,
  type Work,
  type WorkFilters,
} from './work';

// The GitHub Section's list, worked out from the Items: which work each view shows, its state, how it
// is grouped and ordered, and how the filters narrow it and count their choices.

let next = 0;
function item(source: SourceItem): Item {
  next += 1;
  return {
    id: `item-${next}`,
    kind: source.kind,
    source: 'github',
    account: GITHUB,
    externalId: source.externalId,
    title: source.title,
    people: [],
    filing: null,
    status: source.status ?? 'open',
    detail: source.detail ?? null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

const HOUR = 3_600_000;
const work = (...sources: SourceItem[]) => toWork(sources.map(item));
const titles = (list: readonly Work[]) => list.map((each) => each.title);

describe('the GitHub Section’s list', () => {
  it('shows pull requests in one view and issues in the other', () => {
    const all = work(pull({ number: 12, title: 'Retry' }), issue({ number: 30, title: 'Drops' }));
    expect(titles(all.filter((each) => inView(each, 'pulls')))).toEqual(['Retry']);
    expect(titles(all.filter((each) => inView(each, 'issues')))).toEqual(['Drops']);
  });

  it('names each by repo and number, and tells draft, open, merged and closed apart', () => {
    const [draft, open, merged, closed, done] = work(
      pull({ number: 1, draft: true }),
      pull({ number: 2 }),
      pull({ number: 3, state: 'merged' }),
      pull({ number: 4, state: 'closed' }),
      issue({ number: 5, state: 'closed', repo: DOTFILES }),
    );
    expect([draft, open, merged, closed, done].map((each) => each && stateOf(each))).toEqual([
      'draft',
      'open',
      'merged',
      'closed',
      'closed',
    ]);
    expect(done && identifierOf(done)).toBe('octocat/dotfiles#5');
  });

  it('puts open work first by latest activity, and merged and closed behind in Closed, latest closed first', () => {
    const groups = groupWork(
      work(
        pull({ number: 1, title: 'Older', updatedAt: NOW - 5 * HOUR }),
        pull({ number: 2, title: 'Newer', updatedAt: NOW - HOUR }),
        pull({ number: 3, title: 'Draft', draft: true, updatedAt: NOW - 3 * HOUR }),
        pull({ number: 4, title: 'Merged long ago', state: 'merged', mergedAt: NOW - 50 * HOUR }),
        pull({ number: 5, title: 'Closed lately', state: 'closed', closedAt: NOW - 2 * HOUR }),
      ),
    );
    expect(groups.map((group) => [group.id, titles(group.work)])).toEqual([
      ['open', ['Newer', 'Draft', 'Older']],
      ['closed', ['Closed lately', 'Merged long ago']],
    ]);
  });

  it('says how old each is in a few characters', () => {
    expect(ageOf(NOW - 30_000, NOW)).toBe('now');
    expect(ageOf(NOW - 40 * 60_000, NOW)).toBe('40m');
    expect(ageOf(NOW - 5 * HOUR, NOW)).toBe('5h');
    expect(ageOf(NOW - 3 * 24 * HOUR, NOW)).toBe('3d');
    expect(ageOf(NOW - 30 * 24 * HOUR, NOW)).toBe('4w');
    expect(ageOf(NOW - 400 * 24 * HOUR, NOW)).toBe('1y');
  });

  it('lists the reviewers with their latest review, and those still asked', () => {
    const [pr] = work(
      pull({
        number: 12,
        requestedReviewers: [
          { kind: 'user', login: 'octocat', requestedAt: null },
          { kind: 'team', team: 'acme/platform', requestedAt: null },
        ],
        reviews: [
          { login: 'omar', state: 'approved', submittedAt: NOW - HOUR },
          { login: 'sam', state: 'changes-requested', submittedAt: NOW - 2 * HOUR },
        ],
      }),
    );
    expect(pr && isPullRequest(pr) && reviewersOf(pr)).toEqual([
      { name: 'omar', team: false, review: 'approved' },
      { name: 'sam', team: false, review: 'changes-requested' },
      { name: 'octocat', team: false, review: null },
      { name: 'acme/platform', team: true, review: null },
    ]);
  });

  it('finds a linked issue when Commander holds it', () => {
    const all = work(pull({ number: 12 }), issue({ number: 30, title: 'Drops' }));
    expect(linkedWork({ owner: 'acme', name: 'api', number: 30 }, all)?.title).toBe('Drops');
    expect(linkedWork({ owner: 'ACME', name: 'API', number: 30 }, all)?.title).toBe('Drops');
    expect(linkedWork({ owner: 'acme', name: 'api', number: 12 }, all)).toBeUndefined();
    expect(linkedWork({ owner: 'acme', name: 'web', number: 30 }, all)).toBeUndefined();
  });
});

describe('the GitHub filters', () => {
  const all = work(
    pull({
      number: 1,
      title: 'Retry',
      author: 'priya',
      labels: [{ name: 'bug', color: 'd73a4a' }],
    }),
    pull({ number: 2, title: 'Dark mode', repo: WEB, author: 'sam', draft: true }),
    pull({ number: 3, title: 'Dotfiles', repo: DOTFILES, author: 'octocat' }),
    pull({
      number: 4,
      title: 'Merged',
      author: 'priya',
      state: 'merged',
      labels: [{ name: 'bug', color: 'x' }],
    }),
  );
  const pulls = all.filter((each) => inView(each, 'pulls'));
  const filtered = (filters: Partial<WorkFilters>) =>
    titles(pulls.filter((each) => inFilters(each, { ...NO_FILTERS, ...filters })));

  it('narrows by org, repo, author, state and label together', () => {
    expect(filtered({ org: 'acme' })).toEqual(['Retry', 'Dark mode', 'Merged']);
    expect(filtered({ repo: 'acme/web' })).toEqual(['Dark mode']);
    expect(filtered({ author: 'priya' })).toEqual(['Retry', 'Merged']);
    expect(filtered({ state: 'draft' })).toEqual(['Dark mode']);
    expect(filtered({ state: 'merged' })).toEqual(['Merged']);
    expect(filtered({ label: 'bug' })).toEqual(['Retry', 'Merged']);
    expect(filtered({ org: 'acme', author: 'priya', state: 'open' })).toEqual(['Retry']);
  });

  it('counts each choice beside the other filters: open work, except that a state counts its own', () => {
    const options = filterOptions(pulls, { ...NO_FILTERS, author: 'priya' });
    expect(options.org).toEqual([
      { value: 'acme', label: 'acme', count: 1 },
      { value: 'octocat', label: 'octocat', count: 0 },
    ]);
    expect(options.repo).toEqual([
      { value: 'acme/api', label: 'acme/api', count: 1 },
      { value: 'acme/web', label: 'acme/web', count: 0 },
      { value: 'octocat/dotfiles', label: 'octocat/dotfiles', count: 0 },
    ]);
    // The author filter's own counts ignore the author chosen.
    expect(options.author).toEqual([
      { value: 'octocat', label: 'octocat', count: 1 },
      { value: 'priya', label: 'priya', count: 1 },
      { value: 'sam', label: 'sam', count: 1 },
    ]);
    expect(options.state).toEqual([
      { value: 'open', label: 'Open', count: 1 },
      { value: 'draft', label: 'Draft', count: 0 },
      { value: 'merged', label: 'Merged', count: 1 },
      { value: 'closed', label: 'Closed', count: 0 },
    ]);
    expect(options.label).toEqual([{ value: 'bug', label: 'bug', count: 1 }]);
  });

  it('offers authors as People, so one choice covers every GitHub login of a Person', () => {
    const both = work(
      pull({ number: 5, title: 'Docs', author: 'priya' }),
      pull({ number: 6, title: 'Infra', author: 'priya-work' }),
      pull({ number: 7, title: 'Theme', author: 'sam' }),
    );
    const priya: Person = {
      id: 'person-priya',
      name: 'Priya Patel',
      userName: null,
      isUser: false,
      handles: [
        { handle: 'github:priya', source: 'github', name: null },
        { handle: 'github:priya-work', source: 'github', name: null },
        { handle: 'linear:u-priya', source: 'linear', name: 'Priya Patel' },
      ],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const people = lookupOf([priya]);
    expect(filterOptions(both, NO_FILTERS, people).author).toEqual([
      { value: 'person:person-priya', label: 'Priya Patel', count: 2 },
      { value: 'sam', label: 'sam', count: 1 },
    ]);
    const chosen = { ...NO_FILTERS, author: 'person:person-priya' };
    expect(titles(both.filter((each) => inFilters(each, chosen, undefined, people)))).toEqual([
      'Docs',
      'Infra',
    ]);
  });

  it('offers only the states issues have in the Issues view', () => {
    const issues = work(issue({ number: 1 }), issue({ number: 2, state: 'closed' }));
    expect(filterOptions(issues, NO_FILTERS).state.map((option) => option.value)).toEqual(['open', 'closed']);
  });
});
