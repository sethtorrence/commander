import { z } from 'zod';
import { githubRepoName } from './github';
import {
  type OversightSummary,
  oversightDayStart,
  oversightLocalTime,
  oversightProject,
  oversightRangeChoice,
  oversightRangeSpan,
  oversightSectionKinds,
} from './github-oversight';
import type { Item } from './items';

/*
  Ares's GitHub summary (#121): the oversight summary (#119) in his own words, written from its facts
  and from the work itself (each pull request's description, linked issues, review discussion and
  change outline, each skill-managed ticket's "What to build"). It is kept as an Item of Ares's own
  (kind `github-summary`), like a meeting's prep (ADR 0004's amendments): it changes nothing of the
  User's or a Source's, is never written to a Source or filed by Rules, and its words are a model's,
  shown only with AresText.

  - Cadences: a daily summary covering everything since the last one, ready by the time the User first
    opens Commander each day (due once the machine is first active after 05:00, or at the first GitHub
    sync after that); on Mondays a roll-up of the previous Monday to Sunday too; and on demand, for a
    range and a Project, from the GitHub Section.
  - Each summary is kept with its range and scope, so Past summaries reopens any of them. Its entries
    go by section, then Project, then repo (as the facts do), each a sentence or two with the Items it
    is about; Shipped work is grouped by theme within each repo. An entry Commander had to write itself
    (a fire or a stuck pull request Ares left out) is `plain`.
  - It ends "Nothing on fire" when nothing is: Commander says so from the facts, never the model.
  - The latest daily or weekly summary is one Dashboard row: in FYI, or in Today when something is on
    fire. The latest unseen one is an Update line too; opening it in either place marks it seen.
*/

export const WRITE_GITHUB_SUMMARY = 'write-github-summary';
export const WRITE_GITHUB_SUMMARY_NAME = 'Write the GitHub summary';
/** The daily summary is due from this hour, local time. */
export const DAILY_SUMMARY_HOUR = 5;
/** A daily summary never covers more than this, however long since the last. */
export const DAILY_SUMMARY_MAX_DAYS = 7;

const DAY = 24 * 60 * 60 * 1000;
const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();

export const summaryCadences = ['daily', 'weekly', 'on-demand'] as const;
export const summaryCadence = z.enum(summaryCadences);
export type SummaryCadence = z.infer<typeof summaryCadence>;

// One thing Ares says: a sentence or two, the theme it groups (Shipped), and the Items it is about.
export const githubSummaryEntry = z.object({
  theme: z.string().nullable(),
  text: z.string().min(1),
  // Never empty for Ares's own entries; a fire on a branch has no Items behind it.
  itemIds: z.array(id),
  // Written by Commander from the facts, because Ares left out something that must show.
  plain: z.boolean(),
});
export type GitHubSummaryEntry = z.infer<typeof githubSummaryEntry>;

export const githubSummarySection = z.object({
  kind: z.enum(oversightSectionKinds),
  groups: z.array(
    z.object({
      // null: Unfiled.
      project: oversightProject.nullable(),
      repos: z.array(z.object({ repo: githubRepoName, entries: z.array(githubSummaryEntry).min(1) })),
    }),
  ),
});
export type GitHubSummarySection = z.infer<typeof githubSummarySection>;

export const summaryCounts = z.object({
  shipped: z.number().int().nonnegative(),
  started: z.number().int().nonnegative(),
  stuck: z.number().int().nonnegative(),
  onFire: z.number().int().nonnegative(),
});
export type SummaryCounts = z.infer<typeof summaryCounts>;

export const githubSummaryDetail = z.object({
  kind: z.literal('github-summary'),
  cadence: summaryCadence,
  // The local day it was written for (a roll-up: its Monday), which keeps it to one a day.
  day: z.iso.date(),
  range: oversightRangeSpan,
  // Left out: everything; null: Unfiled; else one Project.
  projectId: id.nullable().optional(),
  // What was asked for, on demand; null for the daily summary and the roll-up.
  choice: oversightRangeChoice.nullable(),
  writtenAt: timestamp,
  sections: z.array(githubSummarySection),
  // What is on fire, in plain words from the facts ("Main is failing on acme/api"); empty: nothing.
  onFire: z.array(z.string()),
  counts: summaryCounts,
  // When the User first opened it (on the Dashboard, in the Update or in the GitHub Section).
  seenAt: timestamp.nullable(),
});
export type GitHubSummaryDetail = z.infer<typeof githubSummaryDetail>;
export type GitHubSummaryItem = Item & { detail: GitHubSummaryDetail };

/** Whether an Item is one of Ares's GitHub summaries, with its detail. */
export const isGitHubSummary = (item: Item | null | undefined): item is GitHubSummaryItem =>
  item?.kind === 'github-summary' && item.detail?.kind === 'github-summary';

// How Ares's summary writing stands, so the GitHub Section can say why it shows the plain summary:
// the job switched off (Settings → Ares) or its action Off (Autonomy), or how its last run went.
export const summaryWriterState = z.object({
  enabled: z.boolean(),
  off: z.boolean(),
  lastRunAt: timestamp.nullable(),
  lastOutcome: z.enum(['ok', 'nothing-to-do', 'over-cap', 'invalid-reply', 'failed']).nullable(),
  lastProblem: z.string().nullable(),
});
export type SummaryWriterState = z.infer<typeof summaryWriterState>;

// Ask Ares to write it (the GitHub Section, and later a Conversation): a range, a scope and what the
// range picker said.
export const summaryRequest = z.object({
  range: oversightRangeSpan,
  // Left out: everything; null: Unfiled; else one Project.
  projectId: id.nullable().optional(),
  choice: oversightRangeChoice,
});
export type SummaryRequest = z.infer<typeof summaryRequest>;

/** Why Ares didn't write a summary, in plain words, from how his writing stands. */
export function writerProblem(writer: SummaryWriterState): string | null {
  if (!writer.enabled) return 'Ares’s GitHub summary is switched off in Settings → Ares.';
  if (writer.off) return 'Ares’s GitHub summary is Off in the Autonomy settings.';
  if (writer.lastOutcome === 'over-cap') return 'Ares is over this month’s model spending cap.';
  if (writer.lastOutcome === 'failed' || writer.lastOutcome === 'invalid-reply')
    return `Ares couldn’t write it: ${writer.lastProblem ?? 'the model didn’t answer'}`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// When they are due

export type DueSummary = { cadence: 'daily' | 'weekly'; day: string; range: { from: number; to: number } };

/**
 * The scheduled summaries due at `now`: from 05:00 local time (or `hour`), the day's summary since the
 * last one ended (from the start of yesterday with none yet, never more than a week back), and on a
 * Monday the roll-up of the previous Monday to Sunday. `written` says whether one of a cadence was
 * already kept for a day, so each is written once a day, whatever restarts in between.
 */
export function dueSummaries({
  now,
  timeZone,
  lastDailyTo,
  written,
  hour = DAILY_SUMMARY_HOUR,
}: {
  now: number;
  timeZone: string;
  lastDailyTo: number | null;
  written: (cadence: 'daily' | 'weekly', day: string) => boolean;
  hour?: number;
}): DueSummary[] {
  const local = oversightLocalTime(now, timeZone);
  if (local.hour < hour) return [];
  const due: DueSummary[] = [];
  if (!written('daily', local.day)) {
    const from = Math.max(
      lastDailyTo ?? oversightDayStart(local.day, timeZone, -1),
      now - DAILY_SUMMARY_MAX_DAYS * DAY,
    );
    due.push({ cadence: 'daily', day: local.day, range: { from: Math.min(from, now), to: now } });
  }
  if (local.weekday === 1 && !written('weekly', local.day)) {
    due.push({
      cadence: 'weekly',
      day: local.day,
      range: {
        from: oversightDayStart(local.day, timeZone, -7),
        to: oversightDayStart(local.day, timeZone),
      },
    });
  }
  return due;
}

// ---------------------------------------------------------------------------------------------
// How it reads

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayMonth = (day: string) => {
  const [, month, date] = day.split('-').map(Number) as [number, number, number];
  return `${date} ${MONTHS[month - 1]}`;
};
const weekdayOf = (day: string) => {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, date)).getUTCDay()];
};

/** What a summary covers, in a few words: "since yesterday", "week of 28 Sep", "this week". */
export function summaryRangeLabel(
  detail: Pick<GitHubSummaryDetail, 'cadence' | 'range' | 'choice' | 'day'>,
  timeZone: string,
): string {
  if (detail.cadence === 'weekly')
    return `week of ${dayMonth(oversightLocalTime(detail.range.from, timeZone).day)}`;
  const choice = detail.choice;
  if (choice?.kind === 'this-week') return 'this week';
  if (choice?.kind === 'since') return `since ${dayMonth(choice.day)}`;
  if (choice?.kind === 'since-yesterday') return 'since yesterday';
  // The daily summary: since the last one, which is usually yesterday.
  const from = oversightLocalTime(detail.range.from, timeZone).day;
  if (oversightDayStart(from, timeZone, 1) === oversightDayStart(detail.day, timeZone))
    return 'since yesterday';
  return `since ${weekdayOf(from)} ${dayMonth(from)}`;
}

/** The summary's title (its Item's): "GitHub summary · since yesterday", "GitHub roll-up · week of 28 Sep". */
export function summaryTitle(
  detail: Pick<GitHubSummaryDetail, 'cadence' | 'range' | 'choice' | 'day' | 'projectId'>,
  timeZone: string,
  projectName?: string,
): string {
  const what = detail.cadence === 'weekly' ? 'GitHub roll-up' : 'GitHub summary';
  const scope =
    detail.projectId === undefined ? null : detail.projectId === null ? 'Unfiled' : (projectName ?? null);
  return [what, ...(scope ? [scope] : []), summaryRangeLabel(detail, timeZone)].join(' · ');
}

/** Where the summary's Dashboard row sits, and why: FYI with its counts, or Today when something is on fire. */
export function summaryPlacement(detail: Pick<GitHubSummaryDetail, 'onFire' | 'counts'>): {
  band: 'today' | 'fyi';
  reason: string;
} {
  const [first, ...more] = detail.onFire;
  if (first) return { band: 'today', reason: more.length ? `${first}, and ${more.length} more` : first };
  const { shipped, started, stuck } = detail.counts;
  const parts = [
    ...(shipped ? [`${shipped} shipped`] : []),
    ...(started ? [`${started} started`] : []),
    ...(stuck ? [`${stuck} stuck`] : []),
  ];
  return { band: 'fyi', reason: parts.length ? parts.join(' · ') : 'A quiet day: nothing shipped' };
}

const LEAD_ENTRIES = 2;
const sentence = (text: string) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return /[.!?…]$/.test(one) ? one : `${one}.`;
};

/** The entries in reading order, what is on fire first. */
export function summaryEntries(detail: Pick<GitHubSummaryDetail, 'sections'>): GitHubSummaryEntry[] {
  const order = (kind: string) => (kind === 'on-fire' ? -1 : oversightSectionKinds.indexOf(kind as never));
  return [...detail.sections]
    .sort((a, b) => order(a.kind) - order(b.kind))
    .flatMap((section) => section.groups.flatMap((group) => group.repos.flatMap((repo) => repo.entries)));
}

/** Its first lines, for the Update: what is on fire first, ending "Nothing on fire" when nothing is. */
export function summaryLead(detail: Pick<GitHubSummaryDetail, 'sections' | 'onFire'>): string {
  const lines = summaryEntries(detail)
    .slice(0, LEAD_ENTRIES)
    .map((entry) => sentence(entry.theme ? `${entry.theme}: ${entry.text}` : entry.text));
  if (!lines.length) lines.push('Nothing happened worth telling.');
  if (!detail.onFire.length) lines.push('Nothing on fire.');
  return lines.join(' ');
}

// ---------------------------------------------------------------------------------------------
// From the facts

/** How much the facts hold: what shipped, started, is stuck and is on fire. */
export function summaryCountsOf(facts: OversightSummary): SummaryCounts {
  const counts: SummaryCounts = { shipped: 0, started: 0, stuck: 0, onFire: 0 };
  for (const section of facts.sections)
    for (const group of section.groups)
      for (const { facts: each } of group.entries) {
        if (each.kind === 'shipped') counts.shipped += each.merged + each.issuesClosed + each.tickets.length;
        else if (each.kind === 'started')
          counts.started += each.pullRequests + each.issues + each.claimed.length;
        else if (each.kind === 'stuck') counts.stuck += 1;
        else if (each.kind === 'head-failing' || each.kind === 'reverts') counts.onFire += 1;
      }
  return counts;
}

const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What is on fire, in plain words: "Main is failing on acme/api", "2 reverts on main of acme/web". */
export function onFireLines(facts: OversightSummary): string[] {
  return facts.sections
    .filter((section) => section.kind === 'on-fire')
    .flatMap((section) =>
      section.groups.flatMap((group) =>
        group.entries.flatMap(({ repo, facts: each }) => {
          const name = `${repo.owner}/${repo.name}`;
          if (each.kind === 'head-failing') return [`${upperFirst(each.branch)} is failing on ${name}`];
          if (each.kind === 'reverts') {
            const n = each.commits.length;
            return [`${n} ${n === 1 ? 'revert' : 'reverts'} on ${each.branch} of ${name}`];
          }
          return [];
        }),
      ),
    );
}

/** Whether the facts hold anything at all to write about. */
export const factsEmpty = (facts: OversightSummary) =>
  facts.sections.every((section) => !section.groups.length);
