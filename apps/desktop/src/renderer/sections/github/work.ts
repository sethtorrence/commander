import {
  type GitHubIssueDetail,
  type GitHubReview,
  githubIdentifier,
  type Item,
  type PullRequestDetail,
} from '@commander/domain';
import { NO_PEOPLE, type PeopleLookup } from '../../people/people';

/*
  The GitHub Section's list, worked out from the `pull-request` and `github-issue` Items: the two
  views (Pull requests, Issues), each one's state, the groups (open by latest activity, then merged
  and closed behind Closed), and the GitHub filters (org, repo, author, state, label) with a count
  for each choice. Pure functions, so the Section's hook and its tests share them; open work (#116)
  and the People view (#122) can read the same. The app-wide Project filter is applied beside these
  (projects/filter.ts).
*/

export type PullRequest = Item & { kind: 'pull-request'; detail: PullRequestDetail };
export type GitHubIssue = Item & { kind: 'github-issue'; detail: GitHubIssueDetail };
/** A pull request or an issue, with the detail GitHub sync keeps. */
export type Work = PullRequest | GitHubIssue;

export type WorkView = 'pulls' | 'issues';
export type WorkState = 'draft' | 'open' | 'merged' | 'closed';

export function toWork(items: readonly Item[]): Work[] {
  return items.filter(
    (item): item is Work =>
      (item.kind === 'pull-request' && item.detail?.kind === 'pull-request') ||
      (item.kind === 'github-issue' && item.detail?.kind === 'github-issue'),
  );
}

export const isPullRequest = (work: Work): work is PullRequest => work.kind === 'pull-request';

export function inView(work: Work, view: WorkView): boolean {
  return view === 'pulls' ? isPullRequest(work) : !isPullRequest(work);
}

/** Draft (an open pull request marked draft), open, merged (pull requests only) or closed. */
export function stateOf(work: Work): WorkState {
  const { detail } = work;
  if (detail.state === 'open') return isPullRequest(work) && work.detail.draft ? 'draft' : 'open';
  return detail.state;
}

export const STATE_NAMES: Record<WorkState, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
};

export function isOpen(work: Work): boolean {
  return work.detail.state === 'open';
}

/** "acme/api#12", as people name it. */
export function identifierOf(work: Work): string {
  return githubIdentifier(work.detail.repo, work.detail.number);
}

const ownerOf = (work: Work) => work.detail.repo.owner;
const repoOf = (work: Work) => `${work.detail.repo.owner}/${work.detail.repo.name}`;

/** How long ago, in a few characters: "now", "40m", "5h", "3d", "4w", "1y". */
export function ageOf(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 365)}y`;
}

// ---------------------------------------------------------------------------------------------
// Groups

export type GroupId = 'open' | 'closed';
export interface WorkGroup {
  id: GroupId;
  title: string;
  work: Work[];
}

const closedAt = (work: Work) =>
  (isPullRequest(work) ? work.detail.mergedAt : null) ?? work.detail.closedAt ?? work.detail.updatedAt;

/** Open work first, by latest activity; then merged and closed, latest closed first. */
export function groupWork(list: readonly Work[]): WorkGroup[] {
  return [
    {
      id: 'open',
      title: 'Open',
      work: list.filter(isOpen).sort((a, b) => b.detail.updatedAt - a.detail.updatedAt),
    },
    {
      id: 'closed',
      title: 'Closed',
      work: list.filter((work) => !isOpen(work)).sort((a, b) => closedAt(b) - closedAt(a)),
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Reviewers and linked issues

export interface Reviewer {
  /** A login, or a team as "org/slug". */
  name: string;
  team: boolean;
  /** Their latest review; null while review is only asked of them. */
  review: GitHubReview['state'] | null;
}

/** Who reviewed (each with their latest review), then who is still asked to. */
export function reviewersOf(pull: PullRequest): Reviewer[] {
  const reviewed: Reviewer[] = pull.detail.reviews.map((review) => ({
    name: review.login,
    team: false,
    review: review.state,
  }));
  const done = new Set(reviewed.map((reviewer) => reviewer.name.toLowerCase()));
  const asked: Reviewer[] = pull.detail.requestedReviewers.flatMap((each) => {
    const name = each.kind === 'user' ? each.login : each.team;
    if (done.has(name.toLowerCase())) return [];
    return [{ name, team: each.kind === 'team', review: null }];
  });
  return [...reviewed, ...asked];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The issue a pull request closes (or an issue's parent) among the work Commander holds. */
export function linkedWork(
  ref: { owner: string; name: string; number: number },
  all: readonly Work[],
): GitHubIssue | undefined {
  return all.find(
    (work): work is GitHubIssue =>
      !isPullRequest(work) &&
      work.detail.number === ref.number &&
      same(work.detail.repo.owner, ref.owner) &&
      same(work.detail.repo.name, ref.name),
  );
}

// ---------------------------------------------------------------------------------------------
// Filters

/** The GitHub filters. null is "any". Org is the repo's owner (an org, or a user's own repos). */
export interface WorkFilters {
  org: string | null;
  repo: string | null;
  author: string | null;
  state: WorkState | null;
  label: string | null;
}
export type FilterKey = keyof WorkFilters;
export const FILTER_KEYS: readonly FilterKey[] = ['org', 'repo', 'author', 'state', 'label'];
export const NO_FILTERS: WorkFilters = { org: null, repo: null, author: null, state: null, label: null };

/**
 * The author filter's value for a piece of work: its author's Person (`person:<id>`), so one choice
 * covers every GitHub login of theirs, or the login while no Person is known.
 */
export function authorValue(work: Work, people: PeopleLookup = NO_PEOPLE): string | null {
  const login = work.detail.author;
  if (!login) return null;
  const person = people.personOf(`github:${login}`);
  return person ? `person:${person.id}` : login;
}

function matches(
  work: Work,
  key: FilterKey,
  value: string | null,
  people: PeopleLookup = NO_PEOPLE,
): boolean {
  if (value === null) return true;
  switch (key) {
    case 'org':
      return ownerOf(work) === value;
    case 'repo':
      return repoOf(work) === value;
    case 'author':
      return authorValue(work, people) === value || work.detail.author === value;
    case 'state':
      return stateOf(work) === value;
    case 'label':
      return work.detail.labels.some((label) => label.name === value);
  }
}

export function inFilters(
  work: Work,
  filters: WorkFilters,
  except?: FilterKey,
  people: PeopleLookup = NO_PEOPLE,
): boolean {
  return FILTER_KEYS.every((key) => key === except || matches(work, key, filters[key], people));
}

export interface FilterOption {
  value: string;
  label: string;
  count: number;
}
export type FilterOptions = Record<FilterKey, FilterOption[]>;

const STATE_ORDER: WorkState[] = ['open', 'draft', 'merged', 'closed'];

// Every choice a filter offers, from the work there is (whatever the other filters).
function choicesFor(
  key: FilterKey,
  list: readonly Work[],
  people: PeopleLookup,
): { value: string; label: string }[] {
  const found = new Set<string>();
  // Authors are offered as People: their name, covering every login of theirs.
  const authors = new Map<string, string>();
  for (const work of list) {
    switch (key) {
      case 'org':
        found.add(ownerOf(work));
        break;
      case 'repo':
        found.add(repoOf(work));
        break;
      case 'author': {
        const value = authorValue(work, people);
        const login = work.detail.author;
        if (value && login) authors.set(value, people.personOf(`github:${login}`)?.name ?? login);
        break;
      }
      case 'label':
        for (const label of work.detail.labels) found.add(label.name);
        break;
    }
  }
  if (key === 'state') {
    // Every state the view's kind can be in, in order: issues are never draft or merged.
    const states: WorkState[] = list.some(isPullRequest) ? STATE_ORDER : ['open', 'closed'];
    return states.map((state) => ({ value: state, label: STATE_NAMES[state] }));
  }
  const choices =
    key === 'author'
      ? [...authors].map(([value, label]) => ({ value, label }))
      : [...found].map((value) => ({ value, label: value }));
  return choices.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

/**
 * Each filter's choices, with how much work each would show alongside the other filters: open work,
 * except that a state counts all of its own (so Merged counts merged pull requests). `list` is the
 * work the view and the Project filter let through.
 */
export function filterOptions(
  list: readonly Work[],
  filters: WorkFilters,
  people: PeopleLookup = NO_PEOPLE,
): FilterOptions {
  const options = {} as FilterOptions;
  for (const key of FILTER_KEYS) {
    const counted = list.filter(
      (work) => (key === 'state' || isOpen(work)) && inFilters(work, filters, key, people),
    );
    options[key] = choicesFor(key, list, people).map(({ value, label }) => ({
      value,
      label,
      count: counted.filter((work) => matches(work, key, value, people)).length,
    }));
  }
  return options;
}
