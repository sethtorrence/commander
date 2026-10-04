import {
  type GitHubIssueDetail,
  githubIdentifier,
  type PullRequestDetail,
  type ReviewRequestDetail,
} from './github';
import type { Item } from './items';

/*
  The User's open work on GitHub (#116): their pull requests (with what each waits on), the reviews
  asked of them, and the issues assigned to them. Who the User is on GitHub is their login in the
  Account (GitHub's details name people by login). Pure, so the window, the Item store (GitHub Todos)
  and the rankers judge alike.

  GitHub is read-only in v1: a GitHub Todo only follows what GitHub says, and ticking one changes
  nothing on GitHub.
*/

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type PullRequestItem = Item & { kind: 'pull-request'; detail: PullRequestDetail };
export type ReviewRequestItem = Item & { kind: 'review-request'; detail: ReviewRequestDetail };
export type GitHubIssueItem = Item & { kind: 'github-issue'; detail: GitHubIssueDetail };

export const isPullRequestItem = (item: Item): item is PullRequestItem =>
  item.kind === 'pull-request' && item.detail?.kind === 'pull-request';
export const isReviewRequestItem = (item: Item): item is ReviewRequestItem =>
  item.kind === 'review-request' && item.detail?.kind === 'review-request';
export const isGitHubIssueItem = (item: Item): item is GitHubIssueItem =>
  item.kind === 'github-issue' && item.detail?.kind === 'github-issue';

/** Whether the User (by their login, null while unknown) opened the pull request. */
export function isTheirs(pull: Pick<PullRequestDetail, 'author'>, me: string | null): boolean {
  return me !== null && pull.author !== null && same(pull.author, me);
}

/** Its head commit's checks failed (a failure or an error). */
export function checksFailing(pull: Pick<PullRequestDetail, 'checks'>): boolean {
  return pull.checks === 'failure' || pull.checks === 'error';
}

/** Who asked for changes, by their latest review. */
export function changesRequestedBy(pull: Pick<PullRequestDetail, 'reviews'>): string[] {
  return pull.reviews.filter((review) => review.state === 'changes-requested').map((review) => review.login);
}

/** Changes were asked for: GitHub's review decision says so, or a reviewer's latest review does. */
export function changesRequested(pull: Pick<PullRequestDetail, 'reviews' | 'reviewDecision'>): boolean {
  return pull.reviewDecision === 'changes-requested' || changesRequestedBy(pull).length > 0;
}

/** Who is still asked to review: logins, and teams as "@org/slug". */
export function waitingOn(pull: Pick<PullRequestDetail, 'requestedReviewers'>): string[] {
  return pull.requestedReviewers.map((each) => (each.kind === 'user' ? each.login : `@${each.team}`));
}

/** Since when it has waited: the latest time someone was asked to review it, else when it was opened. */
export function waitingSince(pull: Pick<PullRequestDetail, 'requestedReviewers' | 'createdAt'>): number {
  const asked = pull.requestedReviewers.flatMap((each) =>
    each.requestedAt === null ? [] : [each.requestedAt],
  );
  return asked.length ? Math.max(...asked) : pull.createdAt;
}

/** "Review: Retry webhooks": a review request's Todo, after its pull request. */
export function reviewTodoTitle(pullTitle: string): string {
  return `Review: ${pullTitle}`;
}

/**
 * Why a review request ended, from its pull request as it is now: it was merged or closed, the User
 * gave their review (one submitted since review was last asked of them), or the request was withdrawn.
 */
export function reviewEndedWhy(
  pull: PullRequestDetail | null,
  me: string | null,
  requestedAt: number | null,
): string {
  if (!pull) return 'Review request withdrawn';
  const identifier = githubIdentifier(pull.repo, pull.number);
  if (pull.state === 'merged') return `${identifier} was merged`;
  if (pull.state === 'closed') return `${identifier} was closed`;
  const reviewed = pull.reviews.some(
    (review) =>
      me !== null &&
      same(review.login, me) &&
      review.state !== 'pending' &&
      (requestedAt === null || (review.submittedAt ?? 0) >= requestedAt),
  );
  return reviewed ? 'Review submitted' : 'Review request withdrawn';
}

const and = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/**
 * What an issue means for its GitHub Todo: open while the issue is open and assigned to the User
 * (a skill-managed ticket is claimed by being assigned); none once it closes or goes to others, with
 * why in plain words. With who the User is unknown (null), only the state is judged (`unknown`
 * otherwise): the caller must not make new Todos then.
 */
export type GitHubIssueTodoFate = { todo: 'open' } | { todo: 'unknown' } | { todo: 'none'; why: string };

export function githubIssueTodoFate(detail: GitHubIssueDetail, me: string | null): GitHubIssueTodoFate {
  const identifier = githubIdentifier(detail.repo, detail.number);
  if (detail.state !== 'open') return { todo: 'none', why: `${identifier} was closed` };
  if (me === null) return { todo: 'unknown' };
  if (detail.assignees.some((login) => same(login, me))) return { todo: 'open' };
  if (!detail.assignees.length) return { todo: 'none', why: `${identifier} was unassigned` };
  return { todo: 'none', why: `Reassigned to ${and(detail.assignees)}` };
}

/**
 * The GitHub tab's count: reviews asked of the User directly and still waiting, and their open pull
 * requests failing checks or with changes requested. `users`: the User's login in each GitHub Account.
 */
export function githubTabCount(items: readonly Item[], users: Readonly<Record<string, string>>): number {
  return items.filter((item) => {
    if (item.deletedAt !== null) return false;
    if (isReviewRequestItem(item)) return item.detail.direct;
    if (!isPullRequestItem(item) || item.detail.state !== 'open') return false;
    const me = item.account ? (users[item.account] ?? null) : null;
    return isTheirs(item.detail, me) && (checksFailing(item.detail) || changesRequested(item.detail));
  }).length;
}

// ---------------------------------------------------------------------------------------------
// The band rules for open work (ranking.ts)

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How long something has waited, as a reason says it: "just now", "3h", "1 day", "4 days". */
export function waitedFor(since: number, now: number): string {
  const waited = Math.max(0, now - since);
  if (waited < HOUR) return 'just now';
  if (waited < DAY) return `${Math.floor(waited / HOUR)}h`;
  const days = Math.floor(waited / DAY);
  return `${days} day${days === 1 ? '' : 's'}`;
}

const handleOf = (person: string) => (person.startsWith('github:') ? person.slice('github:'.length) : null);

/** Who asked for a review, as far as Commander knows: the pull request's author (GitHub doesn't say who asked). */
export function reviewAskedBy(request: Pick<Item, 'people'>): string | null {
  return request.people.map(handleOf).find((handle) => handle !== null) ?? null;
}

/** Where open work goes on the Dashboard by the band rules, with why, and when it last moved. */
export type OpenWorkPlace = { band: 'today' | 'waiting' | 'fyi'; reason: string; at: number };

/**
 * The band rules for GitHub's Items (`me`: the User's login in the Item's Account):
 *
 * - **Today:** a review asked of the User directly ("priya asked for your review · 2 days"); their
 *   open pull request with failing checks ("Checks failing on your PR") or changes requested ("omar
 *   requested changes").
 * - **Waiting on others:** their open, ready (not draft) pull request still asking for reviews, not yet
 *   approved ("Waiting on omar's review · 3 days").
 * - **FYI:** a review asked of one of their teams ("Review requested from @acme/backend").
 *
 * Issues assigned to the User aren't placed here: their GitHub Todos follow the Todo rules.
 */
export function placeOpenWork(item: Item, me: string | null, now: number): OpenWorkPlace | null {
  if (isReviewRequestItem(item)) {
    const { direct, teams, requestedAt } = item.detail;
    const at = requestedAt ?? item.createdAt;
    if (direct) {
      const who = reviewAskedBy(item) ?? 'Someone';
      return { band: 'today', reason: `${who} asked for your review · ${waitedFor(at, now)}`, at };
    }
    const named = and(teams.map((team) => `@${team}`));
    return {
      band: 'fyi',
      reason: named ? `Review requested from ${named}` : 'Review requested from your team',
      at,
    };
  }
  if (!isPullRequestItem(item) || item.detail.state !== 'open' || !isTheirs(item.detail, me)) return null;
  const { detail } = item;
  if (checksFailing(detail))
    return { band: 'today', reason: 'Checks failing on your PR', at: detail.updatedAt };
  if (changesRequested(detail)) {
    const who = and(changesRequestedBy(detail));
    return {
      band: 'today',
      reason: who ? `${who} requested changes` : 'Changes requested on your PR',
      at: detail.updatedAt,
    };
  }
  const waiting = waitingOn(detail);
  if (detail.draft || detail.reviewDecision === 'approved' || !waiting.length) return null;
  const since = waitingSince(detail);
  const reviews = waiting.length === 1 ? 'review' : 'reviews';
  return {
    band: 'waiting',
    reason: `Waiting on ${and(waiting)}’s ${reviews} · ${waitedFor(since, now)}`,
    at: since,
  };
}

/** What the band rules go by for open work, for Ares's ranking fingerprint: a change means he ranks it again. */
export function openWorkFacts(item: Item): unknown[] {
  if (isReviewRequestItem(item)) {
    const { direct, teams, requestedAt } = item.detail;
    return [direct, teams, requestedAt];
  }
  if (isPullRequestItem(item)) {
    const { state, draft, checks, reviewDecision, reviews, requestedReviewers, updatedAt } = item.detail;
    return [state, draft, checks, reviewDecision, reviews, requestedReviewers, updatedAt];
  }
  return [];
}
