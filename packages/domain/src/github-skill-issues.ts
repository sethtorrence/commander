import type { GitHubIssueDetail, GitHubRepoName } from './github';
import { type GitHubIssueItem, isGitHubIssueItem } from './github-open-work';
import type { Item } from './items';

/*
  Skill-managed issues (#120). The author's coding-agent skills (wayfinder, triage) keep their work
  as GitHub issues that stay open for weeks on purpose: wayfinder maps, and the tickets under them or
  in a milestone of build tickets. Commander recognises them by label and shows them as progress, so
  they never read as neglect.

  - Skill-managed: an issue with any of the skill-managed labels (Settings → GitHub; by default
    `wayfinder:*` and the five triage labels; a trailing `*` matches any suffix, case never matters),
    or a ticket of a map. A map is an issue labelled `wayfinder:map`, whatever the list says.
  - A map's tickets: its GitHub sub-issues; else issues whose body starts with "Part of #<map>"; else
    the issues in the map's task list ("- [ ] #12"). Build tickets (skill-managed issues in a GitHub
    milestone and under no map) group by repo and milestone, under the milestone's title. The rest
    are skill-managed in no group.
  - Progress: closed tickets of all tickets (closed as not planned counts: it was decided). Commander
    holds closed issues only from the last 30 days, so tickets it doesn't hold are filled in from what
    GitHub counts: the map's sub-issue summary, the ticks in its task list, the milestone's open and
    closed issues. What Commander holds wins over an older count.
  - Blocked: open tickets with an open blocker (GitHub's issue dependencies), each blocker judged as
    Commander holds it now, else as it stood when the ticket was synced.

  Pure, so the oversight summary, the GitHub Section and the Dashboard judge alike.
*/

export const MAP_LABEL = 'wayfinder:map';
export const DEFAULT_SKILL_LABELS: readonly string[] = [
  'wayfinder:*',
  'needs-triage',
  'needs-info',
  'ready-for-agent',
  'ready-for-human',
  'wontfix',
];

const lower = (text: string) => text.toLowerCase();
const same = (a: string, b: string) => lower(a) === lower(b);

/** Whether a label matches a skill-managed label pattern: exactly, or by prefix before a trailing `*`. */
export function matchesSkillLabel(label: string, pattern: string): boolean {
  const wanted = pattern.trim();
  if (wanted.endsWith('*')) return lower(label).startsWith(lower(wanted.slice(0, -1)));
  return same(label, wanted);
}

/** Whether an issue has any of the skill-managed labels. */
export function isSkillLabelled(
  detail: Pick<GitHubIssueDetail, 'labels'>,
  patterns: readonly string[],
): boolean {
  return detail.labels.some((label) => patterns.some((pattern) => matchesSkillLabel(label.name, pattern)));
}

/** Whether an issue is a wayfinder map. */
export function isMap(detail: Pick<GitHubIssueDetail, 'labels'>): boolean {
  return detail.labels.some((label) => same(label.name, MAP_LABEL));
}

type Ref = { owner: string; name: string; number: number };
const keyOf = ({ owner, name, number }: Ref) => lower(`${owner}/${name}#${number}`);
const ownKey = (issue: GitHubIssueItem) => keyOf({ ...issue.detail.repo, number: issue.detail.number });

const NAME = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})';
const REPO = '[A-Za-z0-9._-]{1,100}';
// An issue named in text: a URL, "owner/name#12" or "#12".
const ISSUE = `(?:https?://[^/\\s]+/(${NAME})/(${REPO})/issues/(\\d+)|(?:(${NAME})/(${REPO}))?#(\\d+))`;
const PART_OF = new RegExp(`^\\s*(?:\\*\\*|__)?part of(?:\\*\\*|__)?:?\\s*${ISSUE}`, 'i');
const TASK = new RegExp(`^\\s*[-*+]\\s+\\[([ xX])\\]\\s+${ISSUE}`);

function refIn(match: RegExpMatchArray, offset: number, repo: GitHubRepoName): Ref {
  const [urlOwner, urlName, urlNumber, owner, name, number] = match.slice(offset, offset + 6);
  return urlNumber
    ? { owner: urlOwner ?? '', name: urlName ?? '', number: Number(urlNumber) }
    : { owner: owner ?? repo.owner, name: name ?? repo.name, number: Number(number) };
}

/** The map an issue's body says it is part of ("Part of #1", at the top), if any. */
export function partOf(detail: Pick<GitHubIssueDetail, 'body' | 'repo'>): Ref | null {
  const match = detail.body.match(PART_OF);
  return match ? refIn(match, 1, detail.repo) : null;
}

/** The issues in a map's task list, in order, each with whether it is ticked. */
export function taskListOf(detail: Pick<GitHubIssueDetail, 'body' | 'repo'>): (Ref & { ticked: boolean })[] {
  const found: (Ref & { ticked: boolean })[] = [];
  for (const line of detail.body.split(/\r?\n/)) {
    const match = line.match(TASK);
    if (match) found.push({ ...refIn(match, 2, detail.repo), ticked: match[1] !== ' ' });
  }
  return found;
}

export type SkillGroupKind = 'map' | 'milestone';
export type TicketKind = 'map' | 'map-ticket' | 'build-ticket' | 'ticket';

/** A map or a milestone of build tickets, with its progress. */
export type SkillGroup = {
  // "map:<the map's Item id>" or "milestone:<repo node id>:<title>".
  key: string;
  kind: SkillGroupKind;
  // The map's title, or the milestone's.
  title: string;
  repo: GitHubRepoName;
  // The map's Item (null for a milestone).
  map: GitHubIssueItem | null;
  // The tickets Commander holds: open first, then closed; each by number.
  tickets: GitHubIssueItem[];
  // Closed tickets, of all tickets (those Commander doesn't hold filled in from GitHub's counts).
  done: number;
  total: number;
  // Open tickets with an open blocker.
  blocked: number;
};

export type SkillIssues = {
  // Maps first (by repo, then number), then milestones (by repo, then title).
  groups: SkillGroup[];
  // Every skill-managed issue's Item id, maps included.
  managed: ReadonlySet<string>;
  // A skill-managed issue's group key (a map's own included); null when it is in none.
  groupOf: ReadonlyMap<string, string | null>;
  // What a skill-managed issue is; null for any other Item.
  ticketKind(itemId: string): TicketKind | null;
};

const fullName = (repo: Pick<GitHubRepoName, 'owner' | 'name'>) => `${repo.owner}/${repo.name}`;
const isClosed = (issue: GitHubIssueItem) => issue.detail.state === 'closed';
const byOpenThenNumber = (a: GitHubIssueItem, b: GitHubIssueItem) =>
  Number(isClosed(a)) - Number(isClosed(b)) || a.detail.number - b.detail.number;

/** The skill-managed issues among some Items, with their maps and milestones and each one's progress. */
export function skillIssues(items: readonly Item[], patterns: readonly string[]): SkillIssues {
  const issues = items.filter(
    (item): item is GitHubIssueItem => isGitHubIssueItem(item) && item.deletedAt === null,
  );
  const byRef = new Map(issues.map((issue) => [ownKey(issue), issue]));
  const maps = issues.filter((issue) => isMap(issue.detail));
  const mapByRef = new Map(maps.map((each) => [ownKey(each), each]));

  // Each issue's map: by sub-issue, then "Part of", then a map's task list.
  const mapOf = new Map<string, GitHubIssueItem>();
  const tasks = new Map<string, (Ref & { ticked: boolean })[]>();
  for (const each of maps) tasks.set(each.id, taskListOf(each.detail));
  const inTaskList = new Map<string, GitHubIssueItem>();
  for (const each of maps)
    for (const task of tasks.get(each.id) ?? [])
      if (!inTaskList.has(keyOf(task))) inTaskList.set(keyOf(task), each);
  for (const issue of issues) {
    const own = ownKey(issue);
    const parent = issue.detail.parent ? mapByRef.get(keyOf(issue.detail.parent)) : undefined;
    const part = partOf(issue.detail);
    const found = parent ?? (part ? mapByRef.get(keyOf(part)) : undefined) ?? inTaskList.get(own);
    if (found && found.id !== issue.id) mapOf.set(issue.id, found);
  }

  const managed = new Set<string>();
  const groupOf = new Map<string, string | null>();
  const kinds = new Map<string, TicketKind>();
  const groups = new Map<string, Omit<SkillGroup, 'done' | 'total' | 'blocked'>>();
  for (const each of maps) {
    const key = `map:${each.id}`;
    groups.set(key, { key, kind: 'map', title: each.title, repo: each.detail.repo, map: each, tickets: [] });
  }
  for (const issue of issues) {
    const parentMap = mapOf.get(issue.id);
    const ownMap = isMap(issue.detail);
    if (!parentMap && !ownMap && !isSkillLabelled(issue.detail, patterns)) continue;
    managed.add(issue.id);
    if (parentMap) {
      const key = `map:${parentMap.id}`;
      groups.get(key)?.tickets.push(issue);
      // A map under another map is that map's ticket, and keeps its own group.
      groupOf.set(issue.id, ownMap ? `map:${issue.id}` : key);
      kinds.set(issue.id, ownMap ? 'map' : 'map-ticket');
    } else if (ownMap) {
      groupOf.set(issue.id, `map:${issue.id}`);
      kinds.set(issue.id, 'map');
    } else if (issue.detail.milestone) {
      const { title } = issue.detail.milestone;
      const key = `milestone:${issue.detail.repo.nodeId}:${title}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, kind: 'milestone', title, repo: issue.detail.repo, map: null, tickets: [] };
        groups.set(key, group);
      }
      group.tickets.push(issue);
      groupOf.set(issue.id, key);
      kinds.set(issue.id, 'build-ticket');
    } else {
      groupOf.set(issue.id, null);
      kinds.set(issue.id, 'ticket');
    }
  }

  // Whether a blocker is open: as Commander holds it now, else as it stood when synced.
  const blockerOpen = (blocker: Ref & { state: 'open' | 'closed' }) => {
    const held = byRef.get(keyOf(blocker));
    return held ? !isClosed(held) : blocker.state === 'open';
  };

  const counted = [...groups.values()].map((group): SkillGroup => {
    const tickets = [...group.tickets].sort(byOpenThenNumber);
    let total = tickets.length;
    let done = tickets.filter(isClosed).length;
    const fillIn = (gitHubTotal: number, gitHubClosed: number, held: GitHubIssueItem[]) => {
      const extraTotal = Math.max(0, gitHubTotal - held.length);
      const extraDone = Math.min(extraTotal, Math.max(0, gitHubClosed - held.filter(isClosed).length));
      total += extraTotal;
      done += extraDone;
    };
    if (group.map) {
      const mapKey = ownKey(group.map);
      const { subIssues } = group.map.detail;
      if (subIssues) {
        const subs = tickets.filter(
          (ticket) => ticket.detail.parent && keyOf(ticket.detail.parent) === mapKey,
        );
        fillIn(subIssues.total, subIssues.completed, subs);
      }
      // A task Commander holds is counted as a ticket (or is another map's).
      for (const task of tasks.get(group.map.id) ?? []) {
        if (byRef.has(keyOf(task))) continue;
        total += 1;
        if (task.ticked) done += 1;
      }
    } else {
      const counts = tickets.find((ticket) => ticket.detail.milestone?.issues)?.detail.milestone?.issues;
      if (counts) {
        // Every issue Commander holds in the milestone, skill-managed or not, is in GitHub's count.
        const inMilestone = issues.filter(
          (issue) =>
            issue.detail.repo.nodeId === group.repo.nodeId && issue.detail.milestone?.title === group.title,
        );
        fillIn(counts.open + counts.closed, counts.closed, inMilestone);
      }
    }
    const blocked = tickets.filter(
      (ticket) => !isClosed(ticket) && (ticket.detail.blockedBy ?? []).some(blockerOpen),
    ).length;
    return { ...group, tickets, done, total, blocked };
  });

  const kindRank = (group: SkillGroup) => (group.kind === 'map' ? 0 : 1);
  counted.sort(
    (a, b) =>
      kindRank(a) - kindRank(b) ||
      fullName(a.repo).localeCompare(fullName(b.repo)) ||
      (a.map && b.map ? a.map.detail.number - b.map.detail.number : a.title.localeCompare(b.title)),
  );

  return {
    groups: counted,
    managed,
    groupOf,
    ticketKind: (itemId) => kinds.get(itemId) ?? null,
  };
}

const inRange = (at: number | null, range: { from: number; to: number }) =>
  at !== null && at >= range.from && at <= range.to;

/** How many of a group's tickets opened, and closed, in a range. */
export function changedIn(
  group: Pick<SkillGroup, 'tickets'>,
  range: { from: number; to: number },
): { opened: number; closed: number } {
  return {
    opened: group.tickets.filter((ticket) => inRange(ticket.detail.createdAt, range)).length,
    closed: group.tickets.filter((ticket) => isClosed(ticket) && inRange(ticket.detail.closedAt, range))
      .length,
  };
}
