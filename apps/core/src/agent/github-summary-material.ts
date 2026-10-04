// What Ares reads to write a GitHub summary (#121), gathered by code from the oversight summary's facts
// (#119), never chosen by the model:
//
// - One block of facts per entry (F1, F2…), in Commander's own words: the section, Project and repo,
//   the counts and what it found, naming the Items behind it by their refs. No outside words go in a
//   facts block (titles, bodies, branch names that aren't plain, commit headlines), so it can be the
//   User's (trusted) material.
// - One block per Item (I1, I2…), outside material each in a block of its own (ADR 0004): a pull
//   request with its description, linked issues, reviews and comments and the outline of what changed
//   (the writer's detail), the Linear issues it finishes (by identifier, from finishes Links) and the
//   tickets it closed; a skill-managed ticket with what it asked to build ("What to build") and the
//   pull request that closed it; an issue; a release; a map. Each cut to a length, and all of them to
//   a budget, so the call stays a sensible size; an Item past the budget is only counted.
//
// The refs come back in the reply: what each entry rests on. What each ref may support (its section,
// its Project and repo, the issue numbers and Linear identifiers it names) is kept here, for checking
// the reply in code.
import {
  type GitHubIssueDetail,
  type GitHubReleaseDetail,
  type GitHubRepoName,
  type GitHubWriterDetail,
  githubIdentifier,
  type Item,
  linearIdentifiersIn,
  type OversightEntry,
  type OversightProject,
  type OversightSectionKind,
  type OversightSummary,
  type PullRequestDetail,
  type StuckReason,
} from '@commander/domain';
import type { ItemStore } from '../item-store';
import type { PromptData } from './prompt';

// Bounds on what one call reads: each Item's text, each part of it, how many Items, and all together.
const MAX_ITEMS = 80;
const MAX_ITEM_TEXT = 2_400;
const ITEMS_BUDGET = 60_000;
const MAX_DESCRIPTION = 1_200;
const MAX_LINKED_BODY = 400;
const MAX_REVIEW = 240;
const MAX_COMMENTS = 6;
const MAX_WHAT_TO_BUILD = 1_200;

/** A Project and repo, as an entry is grouped: `<project id or "">|<repo node id>`. */
export type GroupKey = string;
export const groupKeyOf = (
  project: Pick<OversightProject, 'id'> | null,
  repo: Pick<GitHubRepoName, 'nodeId'>,
) => `${project?.id ?? ''}|${repo.nodeId}`;

export type FactRef = {
  ref: string;
  section: OversightSectionKind;
  project: OversightProject | null;
  repo: GitHubRepoName;
  group: GroupKey;
  entry: OversightEntry;
};

export type ItemRef = {
  ref: string;
  itemId: string;
  item: Item;
  // The group it sits in, per section it is in (a pull request opened and merged in the range is in
  // Started and Shipped).
  groups: Map<OversightSectionKind, GroupKey>;
  // Issue and pull request numbers it names in its own repo (its own, its closing and linked issues).
  numbers: Set<number>;
  // The Linear issues it finishes (finishes Links), by identifier.
  finishes: Set<string>;
  // Linear-looking identifiers anywhere in what it says (to tell which prefixes are Linear teams).
  mentioned: Set<string>;
};

export type SummaryMaterial = {
  facts: Map<string, FactRef>;
  items: Map<string, ItemRef>;
  // Facts blocks first, then the Items.
  data: PromptData[];
  // Every Item's ref, by its id.
  refOf: Map<string, string>;
};

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const cut = (text: string, length: number) => {
  const one = oneLine(text);
  return one.length > length ? `${one.slice(0, length - 1).trimEnd()}…` : one;
};
const cutKeepingLines = (text: string, length: number) => {
  const trimmed = text.trim();
  return trimmed.length > length ? `${trimmed.slice(0, length - 1).trimEnd()}…` : trimmed;
};
const counted = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const and = (words: string[]) =>
  words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
const fullName = (repo: Pick<GitHubRepoName, 'owner' | 'name'>) => `${repo.owner}/${repo.name}`;
// A GitHub login, team ("org/slug") or branch is only named when it looks like one: anything else
// may be words someone chose to steer Ares, and stays out of the User's own blocks.
const plainLogin = (login: string) =>
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?(?:\/[A-Za-z0-9._-]{1,100})?$/.test(login);
const plainBranch = (branch: string) => /^[A-Za-z0-9._/-]{1,60}$/.test(branch);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayOf = (at: number) => {
  const date = new Date(at);
  return `${DAY_NAMES[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
};

/** The "What to build" part of a ticket's body (its heading's section), else its opening. */
export function whatToBuild(body: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => /^#{1,6}\s*what to build\b/i.test(line.trim()));
  if (start < 0) return cutKeepingLines(body, MAX_WHAT_TO_BUILD);
  const level = /^(#+)/.exec(lines[start]?.trim() ?? '')?.[1]?.length ?? 2;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const heading = /^(#+)\s/.exec(line.trim());
    return !!heading && (heading[1]?.length ?? 0) <= level;
  });
  return cutKeepingLines((end < 0 ? rest : rest.slice(0, end)).join('\n'), MAX_WHAT_TO_BUILD);
}

function reasonWords(reason: StuckReason): string {
  switch (reason.kind) {
    case 'review-waiting': {
      const who = reason.name !== reason.reviewer || plainLogin(reason.reviewer) ? reason.name : 'a reviewer';
      return `waiting ${counted(reason.days, 'day')} on review from ${who}`;
    }
    case 'checks-failing':
      return 'its checks are failing';
    case 'idle':
      return `open ${counted(reason.openDays, 'day')} with no activity for ${counted(reason.idleDays, 'day')}`;
  }
}

type PullRequest = Item & { detail: PullRequestDetail };
type Issue = Item & { detail: GitHubIssueDetail };
type Release = Item & { detail: GitHubReleaseDetail };

export function gatherSummaryMaterial(
  store: Pick<ItemStore, 'get' | 'githubOversight'>,
  facts: OversightSummary,
): SummaryMaterial {
  const factRefs = new Map<string, FactRef>();
  const itemRefs = new Map<string, ItemRef>();
  const refOf = new Map<string, string>();
  const ticketsClosedBy = new Map<string, number[]>(); // pull request "repo#n" → ticket numbers
  const closedBy = new Map<string, number>(); // ticket "repo#n" → pull request number
  const blocks: { fact: FactRef; text: string }[] = [];
  const itemBlocks: PromptData[] = [];
  let spent = 0;

  // The pull request that closed each skill-managed ticket, from the facts.
  for (const section of facts.sections)
    for (const group of section.groups)
      for (const { repo, facts: each } of group.entries)
        if (each.kind === 'shipped')
          for (const ticket of each.tickets)
            if (ticket.pullRequest !== null) {
              const pull = `${repo.nodeId}#${ticket.pullRequest}`;
              ticketsClosedBy.set(pull, [...(ticketsClosedBy.get(pull) ?? []), ticket.number]);
              closedBy.set(`${repo.nodeId}#${ticket.number}`, ticket.pullRequest);
            }

  const linearOf = (itemId: string): string[] => {
    const view = store.get(itemId);
    return (view?.links ?? [])
      .filter((link) => link.type === 'finishes' && link.to.kind === 'linear-issue')
      .flatMap((link) => {
        const linear = store.get(link.to.id)?.item;
        return linear?.detail?.kind === 'linear-issue' ? [linear.detail.identifier] : [];
      });
  };

  function pullText(pull: PullRequest, writer: GitHubWriterDetail | null, finishes: string[]): string {
    const { detail } = pull;
    const state =
      detail.state === 'merged'
        ? `merged${detail.mergedAt ? ` on ${dayOf(detail.mergedAt)}` : ''}`
        : detail.state === 'closed'
          ? 'closed without merging'
          : detail.draft
            ? 'open, a draft'
            : 'open';
    const tickets = ticketsClosedBy.get(`${detail.repo.nodeId}#${detail.number}`) ?? [];
    const lines = [
      `Pull request ${githubIdentifier(detail.repo, detail.number)}: ${pull.title}`,
      `By ${detail.author ?? 'someone'}, opened ${dayOf(detail.createdAt)}, ${state}`,
      ...(finishes.length ? [`Finishes Linear issues: ${finishes.join(', ')}`] : []),
      ...(tickets.length ? [`Closed skill-managed tickets: ${tickets.map((n) => `#${n}`).join(', ')}`] : []),
      ...(detail.closingIssues.length
        ? [`Closes: ${detail.closingIssues.map((ref) => githubIdentifier(ref, ref.number)).join(', ')}`]
        : []),
    ];
    const outline = writer?.changeOutline;
    if (outline?.areas.length) {
      const areas = outline.areas
        .slice(0, 6)
        .map(
          (area) => `${area.area} (${counted(area.files, 'file')}, +${area.additions} −${area.deletions})`,
        );
      lines.push(`What changed: ${areas.join('; ')}, of ${counted(outline.totalFiles, 'file')} in all`);
    } else {
      lines.push(
        `What changed: ${counted(detail.changedFiles, 'file')}, +${detail.additions} −${detail.deletions}`,
      );
    }
    const description = writer?.description ?? detail.body;
    if (description.trim()) lines.push(`Description:\n${cutKeepingLines(description, MAX_DESCRIPTION)}`);
    for (const linked of writer?.linkedIssues ?? [])
      lines.push(
        `Linked issue ${githubIdentifier(linked, linked.number)}: ${cut(linked.title, 200)}${
          linked.body.trim() ? `: ${cut(linked.body, MAX_LINKED_BODY)}` : ''
        }`,
      );
    for (const review of writer?.reviews ?? [])
      lines.push(
        `Review by ${review.author ?? 'someone'} (${review.state})${review.body.trim() ? `: ${cut(review.body, MAX_REVIEW)}` : ''}`,
      );
    const comments = [...(writer?.reviewComments ?? []), ...(writer?.comments ?? [])].slice(0, MAX_COMMENTS);
    for (const comment of comments)
      lines.push(`Comment by ${comment.author ?? 'someone'}: ${cut(comment.body, MAX_REVIEW)}`);
    return cutKeepingLines(lines.join('\n'), MAX_ITEM_TEXT);
  }

  function issueText(issue: Issue): string {
    const { detail } = issue;
    const pull = closedBy.get(`${detail.repo.nodeId}#${detail.number}`);
    const state =
      detail.state === 'closed'
        ? `closed${detail.closedAt ? ` on ${dayOf(detail.closedAt)}` : ''}${detail.stateReason === 'not-planned' ? ' as not planned' : ''}`
        : detail.assignees.length
          ? `open, claimed by ${and(detail.assignees)}`
          : 'open';
    const lines = [
      `Issue ${githubIdentifier(detail.repo, detail.number)}: ${issue.title}`,
      `By ${detail.author ?? 'someone'}, opened ${dayOf(detail.createdAt)}, ${state}`,
      ...(detail.labels.length ? [`Labels: ${detail.labels.map((label) => label.name).join(', ')}`] : []),
      ...(detail.milestone ? [`Milestone: ${detail.milestone.title}`] : []),
      ...(pull ? [`Closed by pull request #${pull}`] : []),
    ];
    if (detail.body.trim()) lines.push(`What to build:\n${whatToBuild(detail.body)}`);
    return cutKeepingLines(lines.join('\n'), MAX_ITEM_TEXT);
  }

  function releaseText(release: Release): string {
    const { detail } = release;
    return cutKeepingLines(
      [
        `Release ${detail.tag} of ${fullName(detail.repo)}${detail.name ? `: ${detail.name}` : ''}`,
        ...(detail.publishedAt ? [`Published ${dayOf(detail.publishedAt)}`] : []),
        ...(detail.notes.trim() ? [`Notes:\n${cutKeepingLines(detail.notes, MAX_DESCRIPTION)}`] : []),
      ].join('\n'),
      MAX_ITEM_TEXT,
    );
  }

  // Gives an Item a block of its own (once), while it fits: its ref, or null when it doesn't fit.
  function itemRef(itemId: string, section: OversightSectionKind, group: GroupKey): string | null {
    const known = refOf.get(itemId);
    if (known) {
      itemRefs.get(known)?.groups.set(section, group);
      return known;
    }
    if (itemRefs.size >= MAX_ITEMS) return null;
    const item = store.get(itemId)?.item;
    if (!item || item.deletedAt !== null) return null;
    const detail = item.detail;
    let text: string;
    let label: string;
    const numbers = new Set<number>();
    let finishes: string[] = [];
    if (detail?.kind === 'pull-request') {
      const writer = store.githubOversight.writerDetail(item.id);
      finishes = linearOf(item.id);
      text = pullText(item as PullRequest, writer, finishes);
      label = `Pull request ${githubIdentifier(detail.repo, detail.number)}`;
      numbers.add(detail.number);
      for (const ref of [...detail.closingIssues, ...(writer?.linkedIssues ?? [])])
        if (ref.owner === detail.repo.owner && ref.name === detail.repo.name) numbers.add(ref.number);
      for (const ticket of ticketsClosedBy.get(`${detail.repo.nodeId}#${detail.number}`) ?? [])
        numbers.add(ticket);
    } else if (detail?.kind === 'github-issue') {
      text = issueText(item as Issue);
      label = `Issue ${githubIdentifier(detail.repo, detail.number)}`;
      numbers.add(detail.number);
      const pull = closedBy.get(`${detail.repo.nodeId}#${detail.number}`);
      if (pull) numbers.add(pull);
    } else if (detail?.kind === 'github-release') {
      text = releaseText(item as Release);
      label = `Release of ${fullName(detail.repo)}`;
    } else return null;
    if (spent + text.length > ITEMS_BUDGET) return null;
    spent += text.length;
    const ref = `I${itemRefs.size + 1}`;
    refOf.set(item.id, ref);
    itemRefs.set(ref, {
      ref,
      itemId: item.id,
      item,
      groups: new Map([[section, group]]),
      numbers,
      finishes: new Set(finishes),
      mentioned: new Set(linearIdentifiersIn(text)),
    });
    itemBlocks.push({ label: `${ref} · ${label}`, from: item, text });
    return ref;
  }

  // Each entry's refs, and how many of its Items were left out (past the budget).
  const refsOf = (
    entry: OversightEntry,
    section: OversightSectionKind,
    group: GroupKey,
    ids = entry.itemIds,
  ) => {
    const refs: string[] = [];
    let missing = 0;
    for (const id of ids) {
      const ref = itemRef(id, section, group);
      if (ref) refs.push(ref);
      else missing += 1;
    }
    return { refs, missing };
  };
  const andMore = (missing: number) => (missing ? ` (and ${missing} more not shown)` : '');
  const refsByKind = (refs: string[], kind: Item['kind']) =>
    refs.filter((ref) => itemRefs.get(ref)?.item.kind === kind);

  for (const section of facts.sections) {
    for (const group of section.groups) {
      for (const entry of group.entries) {
        const ref = `F${factRefs.size + 1}`;
        const key = groupKeyOf(group.project, entry.repo);
        const fact: FactRef = {
          ref,
          section: section.kind,
          project: group.project,
          repo: entry.repo,
          group: key,
          entry,
        };
        factRefs.set(ref, fact);
        const where = `${group.project?.name ?? 'Unfiled'} · ${fullName(entry.repo)}`;
        const each = entry.facts;
        let text = '';
        switch (each.kind) {
          case 'shipped': {
            const { refs, missing } = refsOf(entry, section.kind, key);
            const pulls = refsByKind(refs, 'pull-request');
            const issues = refsByKind(refs, 'github-issue');
            const releases = refsByKind(refs, 'github-release');
            text =
              [
                `Shipped in ${where}: ${and(
                  [
                    each.merged ? `${counted(each.merged, 'pull request')} merged` : '',
                    each.issuesClosed ? `${counted(each.issuesClosed, 'issue')} closed as done` : '',
                    each.releases.length ? counted(each.releases.length, 'release') : '',
                    each.tickets.length ? `${counted(each.tickets.length, 'skill-managed ticket')} done` : '',
                  ].filter(Boolean),
                )}.`,
                ...(pulls.length ? [`Pull requests: ${pulls.join(', ')}.`] : []),
                ...(issues.length ? [`Issues and tickets: ${issues.join(', ')}.`] : []),
                ...(releases.length ? [`Releases: ${releases.join(', ')}.`] : []),
              ].join(' ') + andMore(missing);
            break;
          }
          case 'started': {
            const { refs, missing } = refsOf(entry, section.kind, key);
            const claimedBy = each.claimed.map((ticket) => ({
              ref: refs.find((one) => {
                const found = itemRefs.get(one)?.item.detail;
                return found?.kind === 'github-issue' && found.number === ticket.number;
              }),
              by: ticket.by.filter(plainLogin),
            }));
            text =
              [
                `Started in ${where}: ${and(
                  [
                    each.pullRequests ? `${counted(each.pullRequests, 'pull request')} opened` : '',
                    each.issues ? `${counted(each.issues, 'issue')} opened` : '',
                    each.claimed.length
                      ? `${counted(each.claimed.length, 'skill-managed ticket')} claimed`
                      : '',
                  ].filter(Boolean),
                )}.`,
                ...(refs.length ? [`Items: ${refs.join(', ')}.`] : []),
                ...claimedBy
                  .filter((one) => one.ref)
                  .map((one) => `${one.ref} was claimed${one.by.length ? ` by ${and(one.by)}` : ''}.`),
              ].join(' ') + andMore(missing);
            break;
          }
          case 'progress': {
            // A map's own Item, not every ticket under it.
            const mapId = each.group === 'map' ? entry.itemIds[0] : undefined;
            const { refs } = refsOf(entry, section.kind, key, mapId ? [mapId] : []);
            const what =
              each.group === 'map'
                ? `the wayfinder map ${refs[0] ?? ''}`.trim()
                : 'a milestone of build tickets';
            const moved = [
              ...(each.opened ? [`${each.opened} opened`] : []),
              ...(each.closed ? [`${each.closed} closed`] : []),
            ];
            text = `Progress in ${where}: ${what}, ${each.done} of ${each.total} ${
              each.group === 'map' ? 'decided' : 'done'
            }${moved.length ? `; ${and(moved)} in this range` : ''}${each.blocked ? `; ${each.blocked} blocked` : ''}.`;
            break;
          }
          case 'stuck': {
            const { refs } = refsOf(entry, section.kind, key);
            text = `Stuck in ${where}: ${refs[0] ?? 'a pull request'}, ${and(each.reasons.map(reasonWords))}.`;
            break;
          }
          case 'head-failing':
            text = `On fire in ${where}: the default branch${plainBranch(each.branch) ? ` ${each.branch}` : ''} is failing its checks (${each.checks}).`;
            break;
          case 'reverts': {
            const authors = [
              ...new Set(
                each.commits.flatMap((commit) =>
                  commit.author && plainLogin(commit.author) ? [commit.author] : [],
                ),
              ),
            ];
            text = `On fire in ${where}: ${counted(each.commits.length, 'revert commit')} on the default branch${
              plainBranch(each.branch) ? ` ${each.branch}` : ''
            } in this range${authors.length ? `, by ${and(authors)}` : ''}.`;
            break;
          }
        }
        blocks.push({ fact, text });
      }
    }
  }

  return {
    facts: factRefs,
    items: itemRefs,
    refOf,
    data: [
      ...blocks.map(({ fact, text }) => ({
        label: `${fact.ref} · Facts · ${fact.section}`,
        from: 'user-settings' as const,
        text,
      })),
      ...itemBlocks,
    ],
  };
}
