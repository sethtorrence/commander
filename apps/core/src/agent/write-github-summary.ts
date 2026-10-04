// "Write the GitHub summary" (#121): Ares writes the oversight summary in his own words. A Deep job at
// high thinking, registered as Organise / "Write the GitHub summary".
//
// - What he is asked for comes from outside the runner (github-summaries.ts): the daily summary and
//   the Monday roll-up when they are due (`want`), and summaries the User asks for (`ask`), each with a
//   range and a scope. Settings → Ares's Run now writes whatever is due, else one since yesterday.
// - What he reads is gathered by code (github-summary-material.ts) from the oversight summary's facts:
//   a facts block per entry and each Item in a data block of its own, through the prompt builder.
// - The reply is {"entries":[{section, theme, text, refs}]}. Each entry is checked in code, and
//   dropped unless it holds up: it must name refs it was handed, in the section it claims (a fire must
//   rest on a fire, Shipped work on what shipped), all in one Project and repo; and every issue number
//   and Linear identifier it names must be one its Items carry (a pull request "finishing ENG-412"
//   needs a finishes Link to it). Fires and stuck pull requests Ares left out are added in plain words,
//   and Commander, never the model, says "Nothing on fire".
// - The summary is a view: it changes nothing of the User's or a Source's, and is drawn only with
//   AresText, so the runner `apply`s it at any level above Off (Ask works as Auto here: there is
//   nothing to approve), like a meeting's prep. It is kept as an Item of Ares's (kind github-summary,
//   ADR 0004's amendments) with its range and scope; nothing links to it, and its entries keep the ids
//   of the Items they are about.
import { randomUUID } from 'node:crypto';
import {
  factsEmpty,
  type GitHubSummaryDetail,
  type GitHubSummaryEntry,
  type GitHubSummarySection,
  githubSummaryDetail,
  type OversightRangeChoice,
  type OversightRangeSpan,
  type OversightSectionKind,
  type OversightSummary,
  onFireLines,
  oversightLocalTime,
  oversightRange,
  oversightSectionKinds,
  plainLine,
  type SummaryCadence,
  summaryCountsOf,
  summaryTitle,
  WRITE_GITHUB_SUMMARY,
  WRITE_GITHUB_SUMMARY_NAME,
} from '@commander/domain';
import { z } from 'zod';
import type { ItemStore } from '../item-store';
import {
  type FactRef,
  type GroupKey,
  gatherSummaryMaterial,
  type ItemRef,
  type SummaryMaterial,
} from './github-summary-material';
import type { AgentJob, JobInput } from './runner';

// One summary Ares is to write.
export type SummaryWant = {
  // What it is for: `daily:<day>`, `weekly:<day>`, or an asking's own key.
  key: string;
  cadence: SummaryCadence;
  day: string;
  range: OversightRangeSpan;
  // Left out: everything; null: Unfiled; else one Project.
  projectId?: string | null;
  // What the User asked for, on demand.
  choice: OversightRangeChoice | null;
};

type Part = { want: SummaryWant; facts: OversightSummary; material: SummaryMaterial };
type Input = JobInput & { parts: Part[] };

const MAX_TEXT = 400;
const MAX_THEME = 80;

const entry = z
  .object({
    section: z.string().max(40),
    theme: z.string().max(400).nullable().optional().default(null),
    text: z.string().max(3_000),
    refs: z.array(z.string().max(20)).max(80).optional().default([]),
  })
  .nullable()
  .catch(null);
export const OUTPUT = z.object({ entries: z.array(entry).max(200).optional().default([]) });
type Output = z.infer<typeof OUTPUT>;

const SECTION_WORDS: Record<OversightSectionKind, string> = {
  shipped: 'shipped',
  started: 'started',
  progress: 'progress',
  stuck: 'stuck',
  'on-fire': 'on-fire',
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const pad = (n: number) => String(n).padStart(2, '0');
const longWhen = (at: number) => {
  const date = new Date(at);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const instructions = (
  want: SummaryWant,
  now: number,
) => `You are Ares. You write the User's GitHub oversight summary: what shipped, what started, how the skill-managed maps and milestones moved, what is stuck and why, and whether anything is on fire, across the repos they watch. The User leads engineering: they want to know what work was actually done and what needs them, not a list of titles. Write in your own plain, calm voice.

It is now ${longWhen(now)}. The summary covers ${longWhen(want.range.from)} to ${longWhen(want.range.to)}.

Each data block is labelled with its ref. F1, F2… are Commander's facts: one per section, Project and repo, with the counts and the Items behind them by their refs. I1, I2… are the Items themselves: pull requests (with their description, linked issues, reviews and comments, and an outline of which areas changed and how much), issues and skill-managed tickets (with what they asked to build), and releases. Read them to understand the work.

Reply with only this JSON object: {"entries":[{"section":"shipped","theme":"Webhook retries","text":"…","refs":["F1","I2","I3"]}]}
- section: one of shipped, started, progress, stuck, on-fire.
- One entry per piece of work. Under shipped, group the pull requests and tickets that belong together by theme within a repo, and give the group a short theme name; otherwise theme is null.
- text: one or two short, plain sentences (fewer than 45 words) saying what was done and why it matters, or what is wrong, in your own words rather than repeating titles. For a skill-managed ticket, describe the work done from what it asked to build and the pull request that closed it. Name a Linear issue only where a pull request's block says it finishes it.
- refs: every block the entry rests on: the facts block, and each Item it is about, exactly as labelled. An entry with no refs is dropped.
- State only what the blocks support. Leave out what isn't worth the User's time, but never leave out what is stuck or on fire. Don't write "Nothing on fire": Commander adds it.`;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const cut = (text: string, length: number) => {
  const one = oneLine(text);
  return one.length > length ? `${one.slice(0, length - 1).trimEnd()}…` : one;
};

// Upper-case team keys that are never Linear's, whatever an Item mentions.
const NOT_LINEAR = new Set([
  'UTF',
  'SHA',
  'ISO',
  'RFC',
  'CVE',
  'HTTP',
  'TLS',
  'SSL',
  'PEP',
  'ES',
  'ECMA',
  'GPT',
  'AES',
  'RSA',
  'MD',
  'IPV',
]);
const LINEAR_ID = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,9})-(\d{1,7})(?![A-Za-z0-9])/g;
const ISSUE_NUMBER = /(?<![A-Za-z0-9&])#(\d{1,7})(?![0-9])/g;

type Accepted = {
  section: OversightSectionKind;
  group: GroupKey;
  entry: GitHubSummaryEntry;
  facts: Set<string>;
};

/**
 * The reply's entries that hold up, as kept: each in the section it claims and the Project and repo
 * of what it rests on, with the Items it is about. Everything else is dropped, saying why.
 */
export function acceptEntries(
  output: Output,
  material: SummaryMaterial,
): { accepted: Accepted[]; dropped: string[] } {
  const dropped: string[] = [];
  const accepted: Accepted[] = [];
  const items = [...material.items.values()];
  // Team keys that are Linear's: those of the issues the Items finish or mention.
  const teams = new Set(
    items.flatMap((item) => [...item.finishes, ...item.mentioned].map((id) => id.split('-')[0] ?? '')),
  );
  for (const raw of output.entries) {
    if (!raw) {
      dropped.push('an entry that wasn’t one');
      continue;
    }
    const section = oversightSectionKinds.find(
      (kind) => SECTION_WORDS[kind] === raw.section.trim().toLowerCase(),
    );
    const text = cut(raw.text, MAX_TEXT);
    if (!section || !text) {
      dropped.push(!section ? `an entry in no section (${raw.section})` : 'an empty entry');
      continue;
    }
    const named = [...new Set(raw.refs.map((ref) => ref.trim().toUpperCase()))];
    const facts = named.flatMap((ref) => material.facts.get(ref) ?? []);
    const things = named.flatMap((ref) => material.items.get(ref) ?? []);
    if (!facts.length && !things.length) {
      dropped.push(`an entry naming nothing it was given (${raw.refs.join(', ') || 'none'})`);
      continue;
    }
    // Only what is in the section it claims, in one Project and repo.
    const inSection = facts.filter((fact) => fact.section === section);
    const itemsIn = things.filter((item) => item.groups.has(section));
    const group = inSection[0]?.group ?? itemsIn[0]?.groups.get(section);
    if (!group) {
      dropped.push(`an entry under ${section} resting on nothing there (${named.join(', ')})`);
      continue;
    }
    const keptFacts = inSection.filter((fact) => fact.group === group);
    const keptItems = itemsIn.filter((item) => item.groups.get(section) === group);
    // What it says must be what its Items carry: issue numbers and Linear identifiers.
    const sameRepo = items.filter((item) => [...item.groups.values()].includes(group));
    const numbers = new Set(sameRepo.flatMap((item) => [...item.numbers]));
    for (const fact of keptFacts)
      if (fact.entry.facts.kind === 'shipped')
        for (const ticket of fact.entry.facts.tickets) numbers.add(ticket.number);
    const finishes = new Set(sameRepo.flatMap((item) => [...item.finishes]));
    const strayNumber = [...text.matchAll(ISSUE_NUMBER)]
      .map((match) => Number(match[1]))
      .find((n) => !numbers.has(n));
    const strayLinear = [...text.matchAll(LINEAR_ID)]
      .map((match) => `${match[1]}-${match[2]}`)
      .find((id) => {
        const team = id.split('-')[0] ?? '';
        return teams.has(team) && !NOT_LINEAR.has(team) && !finishes.has(id);
      });
    if (strayNumber !== undefined || strayLinear) {
      dropped.push(`an entry naming ${strayLinear ?? `#${strayNumber}`}, which nothing it rests on carries`);
      continue;
    }
    // The Items it names; naming only facts, the Items behind them.
    const itemIds = [
      ...new Set(
        keptItems.length
          ? keptItems.map((item) => item.itemId)
          : keptFacts.flatMap((fact) => fact.entry.itemIds),
      ),
    ];
    const theme = section === 'shipped' && raw.theme?.trim() ? cut(raw.theme, MAX_THEME) : null;
    accepted.push({
      section,
      group,
      entry: { theme, text, itemIds, plain: false },
      facts: new Set(keptFacts.map((fact) => fact.ref)),
    });
  }
  return { accepted, dropped };
}

/**
 * The summary's sections from what was accepted, by section, then Project and repo as the facts go,
 * with any fire or stuck pull request Ares left out added in Commander's plain words.
 */
export function summarySections(
  accepted: readonly Accepted[],
  material: SummaryMaterial,
): GitHubSummarySection[] {
  const covered = new Set(accepted.flatMap((one) => [...one.facts]));
  const about = new Set(accepted.flatMap((one) => one.entry.itemIds.map((id) => `${one.section}|${id}`)));
  const backfilled: Accepted[] = [];
  for (const fact of material.facts.values()) {
    if (fact.section !== 'on-fire' && fact.section !== 'stuck') continue;
    if (covered.has(fact.ref)) continue;
    if (fact.section === 'stuck' && fact.entry.itemIds.every((id) => about.has(`stuck|${id}`))) continue;
    backfilled.push({
      section: fact.section,
      group: fact.group,
      entry: { theme: null, text: plainLine(fact.entry), itemIds: fact.entry.itemIds, plain: true },
      facts: new Set([fact.ref]),
    });
  }
  const all = [...accepted, ...backfilled];
  // The facts' order of groups, per section.
  const order = new Map<string, FactRef>();
  for (const fact of material.facts.values()) {
    const key = `${fact.section}|${fact.group}`;
    if (!order.has(key)) order.set(key, fact);
  }
  const groupOrder = [...order.keys()];
  return oversightSectionKinds.flatMap((kind): GitHubSummarySection[] => {
    const projects: GitHubSummarySection['groups'] = [];
    for (const key of groupOrder) {
      if (!key.startsWith(`${kind}|`)) continue;
      const fact = order.get(key) as FactRef;
      const entries = all
        .filter((one) => one.section === kind && one.group === fact.group)
        .map((one) => one.entry);
      if (!entries.length) continue;
      let project = projects.find((each) => (each.project?.id ?? null) === (fact.project?.id ?? null));
      if (!project) {
        project = { project: fact.project, repos: [] };
        projects.push(project);
      }
      project.repos.push({ repo: fact.repo, entries });
    }
    return projects.length ? [{ kind, groups: projects }] : [];
  });
}

export type WriteGitHubSummaryOptions = {
  now?: () => number;
  // The time zone days and ranges are reckoned in; this machine's unless given.
  timeZone?: string;
  // A summary was written (so open views catch up, and the Update can mention it).
  onWritten?: (itemId: string, want: SummaryWant) => void;
};

export type WriteGitHubSummaryJob = AgentJob<Input, Output> & {
  // The daily summary and the roll-up now due (replacing those wanted before).
  want(wants: SummaryWant[]): void;
  // A summary the User asked for; `settle` says what came of it once the runner is done.
  ask(want: SummaryWant): void;
  // What came of an asking: the summary written, or why there is none. Forgets the asking.
  settle(key: string): { itemId: string | null; problem: string | null };
};

export function writeGitHubSummaryJob(
  itemStore: ItemStore,
  {
    now = Date.now,
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    onWritten,
  }: WriteGitHubSummaryOptions,
): WriteGitHubSummaryJob {
  let scheduled: SummaryWant[] = [];
  const asked = new Map<string, SummaryWant>();
  const outcomes = new Map<string, { itemId: string | null; problem: string | null }>();

  const projectName = (projectId: string | null | undefined) =>
    projectId
      ? itemStore.projects({ includeArchived: true }).find((project) => project.id === projectId)?.name
      : undefined;

  // Settings → Ares's Run now: what is due, else a summary since yesterday.
  function runNow(): SummaryWant[] {
    const due = scheduled.filter((want) => !itemStore.githubSummaries.writtenFor(want.cadence, want.day));
    if (due.length) return due;
    const at = now();
    return [
      {
        key: `run-now:${at}`,
        cadence: 'on-demand',
        day: oversightLocalTime(at, timeZone).day,
        range: oversightRange({ kind: 'since-yesterday' }, at, timeZone),
        choice: { kind: 'since-yesterday' },
      },
    ];
  }

  function save(want: SummaryWant, facts: OversightSummary, sections: GitHubSummarySection[]): string {
    const detail: GitHubSummaryDetail = githubSummaryDetail.parse({
      kind: 'github-summary',
      cadence: want.cadence,
      day: want.day,
      range: want.range,
      ...(want.projectId !== undefined && { projectId: want.projectId }),
      choice: want.choice,
      writtenAt: now(),
      sections,
      onFire: onFireLines(facts),
      counts: summaryCountsOf(facts),
      seenAt: null,
    });
    const id = randomUUID();
    const title = summaryTitle(detail, timeZone, projectName(want.projectId));
    itemStore.record(
      { type: 'create', item: { id, kind: 'github-summary', title, detail } },
      { by: { kind: 'ares' }, why: `Ares wrote the ${title}` },
    );
    return id;
  }

  return {
    job: WRITE_GITHUB_SUMMARY,
    name: WRITE_GITHUB_SUMMARY_NAME,
    tier: 'deep',
    reasoningEffort: 'high',
    action: {
      action: WRITE_GITHUB_SUMMARY,
      actionKind: 'organise',
      section: 'github',
      hint: 'The GitHub summary each morning, on Mondays and when you ask. Ask works as Auto here: there is nothing to approve',
    },
    triggers: {},

    want(wants) {
      scheduled = wants;
    },

    ask(want) {
      asked.set(want.key, want);
    },

    settle(key) {
      asked.delete(key);
      const outcome = outcomes.get(key) ?? { itemId: null, problem: null };
      outcomes.delete(key);
      return outcome;
    },

    gather({ triggers }) {
      const bare = triggers.some((trigger) => trigger.kind === 'request' && !trigger.itemIds?.length);
      const wants = [
        // Written once a day each, whatever restarts or triggers came in between.
        ...scheduled.filter((want) => !itemStore.githubSummaries.writtenFor(want.cadence, want.day)),
        ...asked.values(),
      ];
      if (!wants.length && bare) wants.push(...runNow());
      const parts: Part[] = [];
      for (const want of wants) {
        const facts = itemStore.githubOversight.summary({
          range: want.range,
          ...(want.projectId !== undefined && { projectId: want.projectId }),
        });
        if (factsEmpty(facts)) {
          outcomes.set(want.key, {
            itemId: null,
            problem: 'Nothing happened in this range for Ares to write about.',
          });
          continue;
        }
        parts.push({ want, facts, material: gatherSummaryMaterial(itemStore, facts) });
      }
      // Nothing for the runner to remember: each summary is kept, and never written twice a day.
      return { items: [], run: parts.length > 0, parts };
    },

    // Each summary a call of its own.
    batch(input) {
      return input.parts.map((part) => ({ items: [], run: true, parts: [part] }));
    },

    prompt(input) {
      const part = input.parts[0];
      if (!part) return { instructions: '', data: [] };
      return { instructions: instructions(part.want, now()), data: part.material.data };
    },

    output: OUTPUT,

    apply(answers) {
      const dropped: string[] = [];
      for (const { output, input } of answers) {
        const part = input.parts[0];
        if (!part) continue;
        const { want, facts, material } = part;
        // Written meanwhile (two runs racing a restart): never twice a day.
        if (want.cadence !== 'on-demand' && itemStore.githubSummaries.writtenFor(want.cadence, want.day))
          continue;
        const { accepted, dropped: left } = acceptEntries(output, material);
        dropped.push(...left);
        const id = save(want, facts, summarySections(accepted, material));
        if (asked.has(want.key)) outcomes.set(want.key, { itemId: id, problem: null });
        onWritten?.(id, want);
      }
      return { dropped };
    },
  };
}

export type { FactRef, ItemRef };
