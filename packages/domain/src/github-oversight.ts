import { z } from 'zod';
import {
  type GitHubIssueDetail,
  type GitHubReleaseDetail,
  type GitHubRepoHealth,
  type GitHubRepoName,
  githubCheckState,
  githubIdentifier,
  githubRepoName,
  type PullRequestDetail,
} from './github';
import { closingIssueRefs } from './github-finishes';
import { changedIn, DEFAULT_SKILL_LABELS, skillIssues, type TicketKind } from './github-skill-issues';
import type { Item } from './items';

/*
  The oversight summary's facts (#119): for a time range and a scope (every watched repo, one
  Project, or Unfiled), what Shipped, what Started, what's Stuck and what's On fire, worked out from
  the GitHub Items Commander holds and each watched repo's health, with no model and no request to
  GitHub. Ares writes the summary from these in the next ticket (#121); the plain summary below is
  his input and his fallback.

  - Shipped: pull requests merged in the range and issues closed as done in it, per repo, with the
    releases published in it.
  - Started: pull requests and issues opened in the range, leaving out bots (`[bot]` authors and the
    User's list) and drafts opened and closed within the range.
  - Stuck (as things stand at the range's end): open, non-draft pull requests with a review asked
    more than REVIEW_WAIT_DAYS ago and none since; whose checks are failing; or older than the
    long-running setting with no activity for the idle setting.
  - On fire: watched repos whose default-branch head fails its checks; revert commits on a default
    branch in the range.

  Every entry keeps its Items, the numbers behind it ("waiting 4 days on omar") and its Project and
  repo. Groups go by Project (the Items' filing; a repo's fire goes where most of its Items are filed)
  in the Projects' order, Unfiled last, then by repo. GitHub users stay handles until People land.

  Skill-managed issues (#120, github-skill-issues.ts: wayfinder maps and tickets, by the labels in
  the settings) are progress, not neglect:

  - Progress: one entry per map or milestone of build tickets where tickets opened or closed in the
    range (or the map itself opened), with closed of all tickets ("15 of 26 decided", "7 of 10
    done"), what opened and closed in the range and how many are blocked. A map goes where it is
    filed, a milestone where most of its tickets are.
  - Started counts a ticket when it is claimed (assigned) in the range, never for being opened.
  - Shipped counts a ticket closed as done in the range; a pull request merged in the range that
    closed one shows once, with its ticket, rather than among the merged ones. Tickets closed as not
    planned count in progress, never as work.
  - Issues are never Stuck, so long-lived tickets never read as stuck.
*/

const DAY = 24 * 60 * 60 * 1000;
const timestamp = z.number().int().nonnegative();
const id = z.string().min(1);

// A review asked longer ago than this, with none since, is Stuck.
export const REVIEW_WAIT_DAYS = 2;

// Settings → GitHub → Oversight summary.
export const oversightSettings = z.object({
  // An open pull request older than this many days…
  longRunningDays: z.number().int().min(1).max(365),
  // …with no activity for this many is Stuck.
  idleDays: z.number().int().min(1).max(365),
  // Authors whose pull requests and issues never count as Started (besides every `[bot]` login), as
  // GitHub logins, matched whatever their case and with or without `[bot]`.
  bots: z.array(z.string().trim().min(1).max(100)).max(200),
  // Labels that make an issue skill-managed (#120); a trailing `*` matches any suffix.
  skillLabels: z
    .array(z.string().trim().min(1).max(100))
    .max(100)
    .default(() => [...DEFAULT_SKILL_LABELS]),
});
export type OversightSettings = z.infer<typeof oversightSettings>;
// What saving takes: the skill-managed labels may be left out.
export type OversightSettingsInput = z.input<typeof oversightSettings>;
export const defaultOversightSettings: OversightSettings = {
  longRunningDays: 7,
  idleDays: 5,
  bots: ['dependabot', 'renovate'],
  skillLabels: [...DEFAULT_SKILL_LABELS],
};

// What a summary covers: from one instant to another (the range's end is "now" for Stuck).
export const oversightRangeSpan = z
  .object({ from: timestamp, to: timestamp })
  .refine((range) => range.from <= range.to, 'A range ends after it starts');
export type OversightRangeSpan = z.infer<typeof oversightRangeSpan>;

// A Project as a summary's group names it.
export const oversightProject = z.object({ id, name: z.string(), code: z.string(), accent: z.string() });
export type OversightProject = z.infer<typeof oversightProject>;

export const stuckReason = z.discriminatedUnion('kind', [
  // Review asked of a GitHub user or a team ("org/slug") this many whole days ago, with none since.
  // `name`: the Person's name where the login is matched to one, else the login (or the team).
  z.object({
    kind: z.literal('review-waiting'),
    reviewer: z.string(),
    name: z.string(),
    days: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal('checks-failing') }),
  // Open this many whole days, with no activity for this many.
  z.object({
    kind: z.literal('idle'),
    openDays: z.number().int().nonnegative(),
    idleDays: z.number().int().nonnegative(),
  }),
]);
export type StuckReason = z.infer<typeof stuckReason>;

const ticketKinds = ['map', 'map-ticket', 'build-ticket', 'ticket'] as const satisfies readonly TicketKind[];

export const oversightFacts = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('shipped'),
    merged: z.number().int().nonnegative(),
    issuesClosed: z.number().int().nonnegative(),
    // Release tags, oldest first.
    releases: z.array(z.string()),
    // Skill-managed tickets closed as done, oldest first, each with the pull request that closed it
    // (merged in the range; it isn't among `merged` then).
    tickets: z.array(
      z.object({
        number: z.number().int().positive(),
        title: z.string(),
        kind: z.enum(ticketKinds),
        pullRequest: z.number().int().positive().nullable(),
      }),
    ),
  }),
  z.object({
    kind: z.literal('started'),
    pullRequests: z.number().int().nonnegative(),
    issues: z.number().int().nonnegative(),
    // Skill-managed tickets claimed (assigned) in the range, in the order claimed, with by whom.
    claimed: z.array(
      z.object({ number: z.number().int().positive(), title: z.string(), by: z.array(z.string()) }),
    ),
  }),
  z.object({
    kind: z.literal('progress'),
    group: z.enum(['map', 'milestone']),
    // The map's number; null for a milestone.
    number: z.number().int().positive().nullable(),
    title: z.string(),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    opened: z.number().int().nonnegative(),
    closed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('stuck'),
    number: z.number().int().positive(),
    title: z.string(),
    author: z.string().nullable(),
    reasons: z.array(stuckReason).min(1),
  }),
  z.object({
    kind: z.literal('head-failing'),
    branch: z.string(),
    oid: z.string(),
    checks: githubCheckState,
  }),
  z.object({
    kind: z.literal('reverts'),
    branch: z.string(),
    // Oldest first.
    commits: z.array(
      z.object({ oid: z.string(), headline: z.string(), author: z.string().nullable(), at: timestamp }),
    ),
  }),
]);
export type OversightFacts = z.infer<typeof oversightFacts>;

export const oversightEntry = z.object({ repo: githubRepoName, itemIds: z.array(id), facts: oversightFacts });
export type OversightEntry = z.infer<typeof oversightEntry>;

export const oversightGroup = z.object({
  // null: Unfiled.
  project: oversightProject.nullable(),
  entries: z.array(oversightEntry),
});
export type OversightGroup = z.infer<typeof oversightGroup>;

export const oversightSectionKinds = ['shipped', 'started', 'progress', 'stuck', 'on-fire'] as const;
export type OversightSectionKind = (typeof oversightSectionKinds)[number];
export const oversightSection = z.object({
  kind: z.enum(oversightSectionKinds),
  groups: z.array(oversightGroup),
});
export type OversightSection = z.infer<typeof oversightSection>;

// Per GitHub user active in the scope: the pull requests they merged, opened and reviewed in the
// range, and the open ones Stuck waiting on their review (for the writer and the People view).
export const oversightPerson = z.object({
  login: z.string(),
  // The Person the login is matched to (#117), and the name they go by (the login when unmatched).
  personId: id.nullable(),
  name: z.string(),
  merged: z.array(id),
  opened: z.array(id),
  reviewed: z.array(id),
  waitingOn: z.array(id),
});
export type OversightPerson = z.infer<typeof oversightPerson>;

export const oversightSummarySchema = z.object({
  range: oversightRangeSpan,
  // Left out: everything; null: Unfiled; else one Project.
  projectId: id.nullable().optional(),
  sections: z.array(oversightSection),
  people: z.array(oversightPerson),
});
export type OversightSummary = z.infer<typeof oversightSummarySchema>;

type PullRequest = Item & { detail: PullRequestDetail };
type Issue = Item & { detail: GitHubIssueDetail };
type Release = Item & { detail: GitHubReleaseDetail };

export type OversightInput = {
  range: OversightRangeSpan;
  // Left out: everything; null: Unfiled; else one Project's id.
  projectId?: string | null;
  // The live GitHub Items (pull requests, issues and releases; anything else is ignored).
  items: readonly Item[];
  // Each watched repo's health.
  repos: readonly GitHubRepoHealth[];
  // Every Project, in order (archived ones too, so their Items still group under them).
  projects: readonly OversightProject[];
  settings: OversightSettings;
  // The Person a GitHub login is matched to (People, #117); null (or left out) keeps the login.
  personOf?: (login: string) => { id: string; name: string } | null;
};

const fullName = (repo: Pick<GitHubRepoName, 'owner' | 'name'>) => `${repo.owner}/${repo.name}`;
const wholeDays = (ms: number) => Math.max(0, Math.floor(ms / DAY));
const inRange = (at: number | null, { from, to }: OversightRangeSpan) =>
  at !== null && at >= from && at <= to;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Whether a GitHub login is a bot's: any `[bot]` login, or one on the User's list. */
export function isBot(login: string | null, bots: readonly string[]): boolean {
  if (!login) return false;
  const bare = login.replace(/\[bot\]$/i, '');
  return bare !== login || bots.some((bot) => same(bot.replace(/\[bot\]$/i, ''), bare));
}

const failing = (checks: string | null) => checks === 'failure' || checks === 'error';

// Why an open pull request is Stuck at `now`; empty when it isn't.
function stuckReasons(
  pull: PullRequestDetail,
  now: number,
  settings: OversightSettings,
  nameOf: (login: string) => string,
): StuckReason[] {
  if (pull.state !== 'open' || pull.draft) return [];
  const reasons: StuckReason[] = [];
  let longest: { reviewer: string; since: number } | null = null;
  for (const asked of pull.requestedReviewers) {
    const since = asked.requestedAt;
    if (since === null || now - since <= REVIEW_WAIT_DAYS * DAY) continue;
    const reviewer = asked.kind === 'user' ? asked.login : asked.team;
    // GitHub keeps a reviewer listed only until they review, so a review since the ask (theirs, or
    // anyone's for a team) means it isn't waiting.
    const reviewedSince = pull.reviews.some(
      (review) =>
        review.submittedAt !== null &&
        review.submittedAt >= since &&
        (asked.kind === 'team' || same(review.login, reviewer)),
    );
    if (reviewedSince) continue;
    if (!longest || since < longest.since) longest = { reviewer, since };
  }
  if (longest) {
    const team = longest.reviewer.includes('/');
    reasons.push({
      kind: 'review-waiting',
      reviewer: longest.reviewer,
      name: team ? longest.reviewer : nameOf(longest.reviewer),
      days: wholeDays(now - longest.since),
    });
  }
  if (failing(pull.checks)) reasons.push({ kind: 'checks-failing' });
  if (now - pull.createdAt > settings.longRunningDays * DAY && now - pull.updatedAt > settings.idleDays * DAY)
    reasons.push({
      kind: 'idle',
      openDays: wholeDays(now - pull.createdAt),
      idleDays: wholeDays(now - pull.updatedAt),
    });
  return reasons;
}

// The reviewer a Stuck pull request waits on, if a person.
function waitingOn(pull: PullRequestDetail, reasons: StuckReason[]): string | null {
  const waiting = reasons.find((reason) => reason.kind === 'review-waiting');
  if (waiting?.kind !== 'review-waiting') return null;
  return pull.requestedReviewers.some((asked) => asked.kind === 'user' && asked.login === waiting.reviewer)
    ? waiting.reviewer
    : null;
}

type ShippedTicket = Extract<OversightFacts, { kind: 'shipped' }>['tickets'][number];
type ClaimedTicket = Extract<OversightFacts, { kind: 'started' }>['claimed'][number];
type ProgressFacts = Extract<OversightFacts, { kind: 'progress' }>;
// Maps first, by number; then milestones, by title.
const progressOrder = (a: ProgressFacts, b: ProgressFacts) =>
  (a.number === null ? 1 : 0) - (b.number === null ? 1 : 0) ||
  (a.number ?? 0) - (b.number ?? 0) ||
  a.title.localeCompare(b.title);

const KIND_ORDER: Item['kind'][] = ['pull-request', 'github-issue', 'github-release'];

type Placed = { projectId: string | null; repo: GitHubRepoName; itemIds: string[]; facts: OversightFacts };

/** The oversight summary: what Shipped, Started, is Stuck and is On fire, grouped by Project then repo. */
export function oversightSummary(input: OversightInput): OversightSummary {
  const { range, settings } = input;
  const now = range.to;
  const pulls = input.items.filter((item): item is PullRequest => item.detail?.kind === 'pull-request');
  const issues = input.items.filter((item): item is Issue => item.detail?.kind === 'github-issue');
  const releases = input.items.filter((item): item is Release => item.detail?.kind === 'github-release');
  const kinds = new Map(input.items.map((item) => [item.id, item.kind]));
  const personOf = (login: string) => input.personOf?.(login) ?? null;
  const nameOf = (login: string) => personOf(login)?.name ?? login;
  const skill = skillIssues(issues, settings.skillLabels ?? DEFAULT_SKILL_LABELS);
  const managed = (issue: Issue) => skill.managed.has(issue.id);
  const projectOf = (item: Item) => item.filing?.projectId ?? null;
  const order = new Map(input.projects.map((project, index) => [project.id, index]));
  // The Project most of some Items are filed in (the first in order on a tie); null when none is.
  const mostFiled = (items: readonly Item[]): string | null => {
    const counts = new Map<string, number>();
    for (const each of items) {
      const projectId = projectOf(each);
      if (projectId) counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
    }
    let best: string | null = null;
    for (const [projectId, n] of counts) {
      const current = best === null ? -1 : (counts.get(best) ?? 0);
      if (n > current || (n === current && (order.get(projectId) ?? 1e9) < (order.get(best ?? '') ?? 1e9)))
        best = projectId;
    }
    return best;
  };
  const placed: Record<OversightSectionKind, Placed[]> = {
    shipped: [],
    started: [],
    progress: [],
    stuck: [],
    'on-fire': [],
  };

  // Shipped and Started: one entry per Project and repo, its Items in time order.
  type Tally = {
    projectId: string | null;
    repo: GitHubRepoName;
    items: { id: string; at: number }[];
    merged: number;
    issuesClosed: number;
    releases: [number, string][];
    tickets: [number, ShippedTicket][];
    pullRequests: number;
    issues: number;
    claimed: [number, ClaimedTicket][];
  };
  const tally = (into: Map<string, Tally>, item: Item, repo: GitHubRepoName, at: number) => {
    const key = `${projectOf(item) ?? ''}\u0000${repo.nodeId}`;
    let found = into.get(key);
    if (!found) {
      found = {
        projectId: projectOf(item),
        repo,
        items: [],
        merged: 0,
        issuesClosed: 0,
        releases: [],
        tickets: [],
        pullRequests: 0,
        issues: 0,
        claimed: [],
      };
      into.set(key, found);
    }
    found.items.push({ id: item.id, at });
    return found;
  };
  // Pull requests, then issues, then releases; each kind oldest first.
  const kindRank = (itemId: string) => KIND_ORDER.indexOf(kinds.get(itemId) ?? 'github-release');
  const ordered = (each: Tally) =>
    [...each.items].sort((a, b) => kindRank(a.id) - kindRank(b.id) || a.at - b.at).map((one) => one.id);

  const shipped = new Map<string, Tally>();
  const merged = pulls.filter(
    (pull) => pull.detail.state === 'merged' && inRange(pull.detail.mergedAt, range),
  );
  const closedAsDone = issues.filter(
    ({ detail }) =>
      detail.state === 'closed' &&
      inRange(detail.closedAt, range) &&
      (detail.stateReason === 'completed' || detail.stateReason === null),
  );
  // The pull request merged in the range that closed each skill-managed ticket, where one did.
  const refKey = (ref: { owner: string; name: string; number: number }) =>
    `${ref.owner}/${ref.name}#${ref.number}`.toLowerCase();
  const closer = new Map<string, PullRequest>();
  for (const pull of merged)
    for (const ref of [...pull.detail.closingIssues, ...closingIssueRefs(pull.detail.body, pull.detail.repo)])
      if (!closer.has(refKey(ref))) closer.set(refKey(ref), pull);
  const ticketsBy = new Map<string, Issue[]>();
  const shippedTicket = (ticket: Issue, pullRequest: number | null): ShippedTicket => ({
    number: ticket.detail.number,
    title: ticket.title,
    kind: skill.ticketKind(ticket.id) ?? 'ticket',
    pullRequest,
  });
  for (const ticket of closedAsDone) {
    if (!managed(ticket)) continue;
    const pull = closer.get(refKey({ ...ticket.detail.repo, number: ticket.detail.number }));
    if (pull) ticketsBy.set(pull.id, [...(ticketsBy.get(pull.id) ?? []), ticket]);
    else {
      const at = ticket.detail.closedAt ?? 0;
      tally(shipped, ticket, ticket.detail.repo, at).tickets.push([at, shippedTicket(ticket, null)]);
    }
  }
  for (const pull of merged) {
    const entry = tally(shipped, pull, pull.detail.repo, pull.detail.mergedAt ?? 0);
    const closed = ticketsBy.get(pull.id);
    if (!closed) entry.merged += 1;
    for (const ticket of closed ?? []) {
      const at = ticket.detail.closedAt ?? 0;
      entry.items.push({ id: ticket.id, at });
      entry.tickets.push([at, shippedTicket(ticket, pull.detail.number)]);
    }
  }
  for (const issue of closedAsDone) {
    if (managed(issue)) continue;
    const entry = tally(shipped, issue, issue.detail.repo, issue.detail.closedAt ?? 0);
    entry.issuesClosed += 1;
  }
  for (const each of releases) {
    if (!inRange(each.detail.publishedAt, range)) continue;
    const at = each.detail.publishedAt ?? 0;
    const entry = tally(shipped, each, each.detail.repo, at);
    entry.releases.push([at, each.detail.tag]);
  }
  for (const each of shipped.values())
    placed.shipped.push({
      projectId: each.projectId,
      repo: each.repo,
      itemIds: ordered(each),
      facts: {
        kind: 'shipped',
        merged: each.merged,
        issuesClosed: each.issuesClosed,
        releases: [...each.releases].sort((a, b) => a[0] - b[0]).map(([, tag]) => tag),
        tickets: [...each.tickets].sort((a, b) => a[0] - b[0]).map(([, ticket]) => ticket),
      },
    });

  const started = new Map<string, Tally>();
  for (const pull of pulls) {
    const { detail } = pull;
    if (!inRange(detail.createdAt, range) || isBot(detail.author, settings.bots)) continue;
    if (detail.draft && detail.state !== 'open' && inRange(detail.closedAt ?? detail.mergedAt, range))
      continue;
    const entry = tally(started, pull, detail.repo, detail.createdAt);
    entry.pullRequests += 1;
  }
  for (const issue of issues) {
    const { detail } = issue;
    if (managed(issue)) {
      // A ticket starts when it is claimed.
      const claimed = detail.claimedAt ?? null;
      if (skill.ticketKind(issue.id) === 'map' || !detail.assignees.length || !inRange(claimed, range))
        continue;
      const entry = tally(started, issue, detail.repo, claimed ?? 0);
      entry.claimed.push([
        claimed ?? 0,
        { number: detail.number, title: issue.title, by: [...detail.assignees] },
      ]);
      continue;
    }
    if (!inRange(detail.createdAt, range) || isBot(detail.author, settings.bots)) continue;
    const entry = tally(started, issue, detail.repo, detail.createdAt);
    entry.issues += 1;
  }
  for (const each of started.values())
    placed.started.push({
      projectId: each.projectId,
      repo: each.repo,
      itemIds: ordered(each),
      facts: {
        kind: 'started',
        pullRequests: each.pullRequests,
        issues: each.issues,
        claimed: [...each.claimed].sort((a, b) => a[0] - b[0]).map(([, ticket]) => ticket),
      },
    });

  // Progress: per map or milestone that moved in the range.
  for (const group of skill.groups) {
    const { opened, closed } = changedIn(group, range);
    const mapOpened = !!group.map && inRange(group.map.detail.createdAt, range);
    if (!opened && !closed && !mapOpened) continue;
    placed.progress.push({
      projectId: group.map ? projectOf(group.map) : mostFiled(group.tickets),
      repo: group.repo,
      itemIds: [...(group.map ? [group.map.id] : []), ...group.tickets.map((ticket) => ticket.id)],
      facts: {
        kind: 'progress',
        group: group.kind,
        number: group.map?.detail.number ?? null,
        title: group.title,
        done: group.done,
        total: group.total,
        opened,
        closed,
        blocked: group.blocked,
      },
    });
  }

  // Stuck: one entry per pull request.
  const stuckWaits = new Map<string, string>();
  for (const pull of pulls) {
    const reasons = stuckReasons(pull.detail, now, settings, nameOf);
    if (!reasons.length) continue;
    const reviewer = waitingOn(pull.detail, reasons);
    if (reviewer) stuckWaits.set(pull.id, reviewer);
    placed.stuck.push({
      projectId: projectOf(pull),
      repo: pull.detail.repo,
      itemIds: [pull.id],
      facts: {
        kind: 'stuck',
        number: pull.detail.number,
        title: pull.title,
        author: pull.detail.author,
        reasons,
      },
    });
  }

  // On fire: per watched repo, filed where most of its Items are.
  const repoProject = (repo: GitHubRepoName): string | null =>
    mostFiled([...pulls, ...issues].filter((work) => work.detail.repo.nodeId === repo.nodeId));
  for (const health of input.repos) {
    const branch = health.defaultBranch ?? 'main';
    if (health.head && failing(health.head.checks))
      placed['on-fire'].push({
        projectId: repoProject(health.repo),
        repo: health.repo,
        itemIds: [],
        facts: {
          kind: 'head-failing',
          branch,
          oid: health.head.oid,
          checks: health.head.checks ?? 'failure',
        },
      });
    const reverts = health.commits
      .filter((commit) => commit.revert && inRange(commit.committedAt, range))
      .sort((a, b) => a.committedAt - b.committedAt);
    if (reverts.length)
      placed['on-fire'].push({
        projectId: repoProject(health.repo),
        repo: health.repo,
        itemIds: [],
        facts: {
          kind: 'reverts',
          branch,
          commits: reverts.map((commit) => ({
            oid: commit.oid,
            headline: commit.headline,
            author: commit.author.login ?? commit.author.name,
            at: commit.committedAt,
          })),
        },
      });
  }

  // Scope and grouping.
  const wanted = (projectId: string | null) => input.projectId === undefined || input.projectId === projectId;
  const projects = new Map(input.projects.map((project) => [project.id, project]));
  const groupKey = (projectId: string | null) =>
    projectId !== null && projects.has(projectId) ? projectId : null;
  const rank = (projectId: string | null) =>
    projectId === null ? Number.MAX_SAFE_INTEGER : (order.get(projectId) ?? 0);
  const sections = oversightSectionKinds.map((kind): OversightSection => {
    const groups = new Map<string | null, OversightEntry[]>();
    for (const entry of placed[kind]) {
      if (!wanted(entry.projectId)) continue;
      const key = groupKey(entry.projectId);
      groups.set(key, [
        ...(groups.get(key) ?? []),
        { repo: entry.repo, itemIds: entry.itemIds, facts: entry.facts },
      ]);
    }
    return {
      kind,
      groups: [...groups]
        .sort(([a], [b]) => rank(a) - rank(b))
        .map(([projectId, entries]) => ({
          project: projectId === null ? null : (projects.get(projectId) ?? null),
          entries: entries.sort(
            (a, b) =>
              fullName(a.repo).localeCompare(fullName(b.repo)) ||
              (a.facts.kind === 'stuck' && b.facts.kind === 'stuck' ? a.facts.number - b.facts.number : 0) ||
              (a.facts.kind === 'progress' && b.facts.kind === 'progress'
                ? progressOrder(a.facts, b.facts)
                : 0),
          ),
        })),
    };
  });

  // People, within the scope.
  const people = new Map<string, OversightPerson>();
  const person = (login: string) => {
    const key = login.toLowerCase();
    let found = people.get(key);
    if (!found) {
      const matched = personOf(login);
      found = {
        login,
        personId: matched?.id ?? null,
        name: matched?.name ?? login,
        merged: [],
        opened: [],
        reviewed: [],
        waitingOn: [],
      };
      people.set(key, found);
    }
    return found;
  };
  for (const pull of pulls) {
    if (!wanted(projectOf(pull))) continue;
    const { detail } = pull;
    if (detail.author && !isBot(detail.author, settings.bots)) {
      if (detail.state === 'merged' && inRange(detail.mergedAt, range))
        person(detail.author).merged.push(pull.id);
      if (inRange(detail.createdAt, range)) person(detail.author).opened.push(pull.id);
    }
    for (const review of detail.reviews)
      if (inRange(review.submittedAt, range) && !same(review.login, detail.author ?? ''))
        person(review.login).reviewed.push(pull.id);
    const reviewer = stuckWaits.get(pull.id);
    if (reviewer) person(reviewer).waitingOn.push(pull.id);
  }

  return {
    range,
    ...(input.projectId !== undefined && { projectId: input.projectId }),
    sections,
    people: [...people.values()].sort((a, b) => a.login.localeCompare(b.login)),
  };
}

// ---------------------------------------------------------------------------------------------
// The plain summary

export type PlainLine = {
  text: string;
  itemIds: string[];
  repo: GitHubRepoName;
  // A Progress line's counts, for its progress bar.
  progress?: { done: number; total: number };
};
export type PlainGroup = { project: OversightProject | null; title: string; lines: PlainLine[] };
export type PlainSection = { kind: OversightSectionKind; title: string; groups: PlainGroup[] };
export type PlainSummary = {
  sections: PlainSection[];
  // "Nothing on fire" when nothing is; null otherwise.
  closing: string | null;
  // Nothing in any section.
  empty: boolean;
};

export const OVERSIGHT_SECTION_TITLES: Record<OversightSectionKind, string> = {
  shipped: 'Shipped',
  started: 'Started',
  progress: 'Progress',
  stuck: 'Stuck',
  'on-fire': 'On fire',
};

const TICKET_WORDS: Record<TicketKind, string> = {
  map: 'map',
  'map-ticket': 'map ticket',
  'build-ticket': 'build ticket',
  ticket: 'ticket',
};

const counted = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const and = (words: string[]) =>
  words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;

function reasonText(reason: StuckReason): string {
  switch (reason.kind) {
    case 'review-waiting':
      return `waiting ${counted(reason.days, 'day')} on ${reason.name}`;
    case 'checks-failing':
      return 'checks failing';
    case 'idle':
      return `open ${counted(reason.openDays, 'day')}, no activity for ${counted(reason.idleDays, 'day')}`;
  }
}

/** One entry's line, as the plain summary writes it. */
export function plainLine({ repo, facts }: OversightEntry): string {
  const name = fullName(repo);
  switch (facts.kind) {
    case 'shipped': {
      const parts = [
        ...(facts.merged ? [`${counted(facts.merged, 'PR')} merged`] : []),
        ...(facts.issuesClosed ? [`${counted(facts.issuesClosed, 'issue')} closed`] : []),
        ...(facts.releases.length
          ? [`${facts.releases.length === 1 ? 'release' : 'releases'} ${and(facts.releases)}`]
          : []),
        ...facts.tickets.map((ticket) =>
          ticket.pullRequest === null
            ? `#${ticket.number} done (${TICKET_WORDS[ticket.kind]})`
            : `#${ticket.pullRequest} closes #${ticket.number} (${TICKET_WORDS[ticket.kind]})`,
        ),
      ];
      return `${name}: ${parts.join(', ')}`;
    }
    case 'started': {
      const opened = [
        ...(facts.pullRequests ? [counted(facts.pullRequests, 'PR')] : []),
        ...(facts.issues ? [counted(facts.issues, 'issue')] : []),
      ];
      const parts = [
        ...(opened.length ? [`${and(opened)} opened`] : []),
        ...facts.claimed.map((ticket) => `claimed #${ticket.number} ${ticket.title} (${and(ticket.by)})`),
      ];
      return `${name}: ${parts.join(', ')}`;
    }
    case 'progress': {
      const what =
        facts.group === 'map' && facts.number !== null
          ? `${githubIdentifier(repo, facts.number)} ${facts.title}`
          : `${name} milestone ${facts.title}`;
      const moved = [
        ...(facts.opened ? [`${facts.opened} opened`] : []),
        ...(facts.closed ? [`${facts.closed} closed`] : []),
      ];
      const parts = [
        `${facts.done} of ${facts.total} ${facts.group === 'map' ? 'decided' : 'done'}`,
        ...(moved.length ? [and(moved)] : []),
        ...(facts.blocked ? [`${facts.blocked} blocked`] : []),
      ];
      return `${what}: ${parts.join(', ')}`;
    }
    case 'stuck':
      return `${githubIdentifier(repo, facts.number)} ${facts.title}: ${facts.reasons.map(reasonText).join(', ')}`;
    case 'head-failing':
      return `${name}: ${facts.branch} is failing its checks`;
    case 'reverts':
      return `${name}: ${counted(facts.commits.length, 'revert')} on ${facts.branch}: ${facts.commits
        .map((commit) => commit.headline)
        .join('; ')}`;
  }
}

/** The summary as plain lines: per section, per Project, one line per entry, ending "Nothing on fire". */
export function plainSummary(summary: OversightSummary): PlainSummary {
  const sections = summary.sections.map(
    (section): PlainSection => ({
      kind: section.kind,
      title: OVERSIGHT_SECTION_TITLES[section.kind],
      groups: section.groups.map((group) => ({
        project: group.project,
        title: group.project?.name ?? 'Unfiled',
        lines: group.entries.map((entry) => ({
          text: plainLine(entry),
          itemIds: entry.itemIds,
          repo: entry.repo,
          ...(entry.facts.kind === 'progress' && {
            progress: { done: entry.facts.done, total: entry.facts.total },
          }),
        })),
      })),
    }),
  );
  const onFire = sections.find((section) => section.kind === 'on-fire');
  return {
    sections,
    closing: onFire?.groups.length ? null : 'Nothing on fire',
    empty: sections.every((section) => !section.groups.length),
  };
}

// ---------------------------------------------------------------------------------------------
// Ranges

// The range picker's choices: Since yesterday (the default), This week, Custom since a day.
export const oversightRangeChoice = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('since-yesterday') }),
  z.object({ kind: z.literal('this-week') }),
  z.object({ kind: z.literal('since'), day: z.iso.date() }),
]);
export type OversightRangeChoice = z.infer<typeof oversightRangeChoice>;

// The wall-clock reading of an instant in a time zone, as if it were UTC.
function wallClock(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((each) => each.type === type)?.value ?? 0);
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
}

// The instant a calendar day (as a UTC midnight) starts in a time zone.
function startOfDay(dayAsUtc: number, timeZone: string): number {
  // The offset at the UTC reading, then again at the guess, which settles a daylight-saving change.
  const guess = dayAsUtc - (wallClock(dayAsUtc, timeZone) - dayAsUtc);
  return dayAsUtc - (wallClock(guess, timeZone) - guess);
}

/** The span a range choice covers at `now`, in the User's time zone: from a day's start to now. */
export function oversightRange(
  choice: OversightRangeChoice,
  now: number,
  timeZone: string,
): OversightRangeSpan {
  const local = wallClock(now, timeZone);
  const today = local - (((local % DAY) + DAY) % DAY);
  let day: number;
  switch (choice.kind) {
    case 'since-yesterday':
      day = today - DAY;
      break;
    case 'this-week': {
      // Monday is the first day of the week.
      const weekday = (new Date(today).getUTCDay() + 6) % 7;
      day = today - weekday * DAY;
      break;
    }
    case 'since': {
      const [year, month, date] = choice.day.split('-').map(Number) as [number, number, number];
      day = Date.UTC(year, month - 1, date);
      break;
    }
  }
  return { from: Math.min(startOfDay(day, timeZone), now), to: now };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** An instant's calendar day (YYYY-MM-DD), hour and weekday (0 is Sunday) in a time zone. */
export function oversightLocalTime(
  at: number,
  timeZone: string,
): { day: string; hour: number; weekday: number } {
  const local = new Date(wallClock(at, timeZone));
  return {
    day: `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}`,
    hour: local.getUTCHours(),
    weekday: local.getUTCDay(),
  };
}

/** The instant a calendar day (YYYY-MM-DD) starts in a time zone, or `plusDays` days after it. */
export function oversightDayStart(day: string, timeZone: string, plusDays = 0): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return startOfDay(Date.UTC(year, month - 1, date + plusDays), timeZone);
}
