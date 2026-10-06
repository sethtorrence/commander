// Ares's paragraph about one Person's week (#122): what he reads, gathered by code from the People
// view's facts (never chosen by the model), and how his reply is checked in code before it is kept.
//
// - One block of facts (F1), in Commander's own words: what they merged, reviewed and opened, what is
//   open and for how long (and why it is stuck), the reviews waiting on them and their Linear issues,
//   naming each Item by its ref. No outside words go in it (titles, bodies, Linear state names); a
//   name that doesn't look like a name stays out, so it can be the User's (trusted) material.
// - One block per Item (I1, I2…), outside material each in a block of its own (ADR 0004): each pull
//   request with its description, reviews and the Linear issues it finishes, and each Linear issue.
//   Cut to a length, and all of them to a budget.
//
// The reply is {"sentences":[{text, refs}]}. Each sentence is a claim, kept only if it holds up
// against the blocks it names (all of them when it names only the facts):
// - it names refs it was handed;
// - every issue or pull request number (#14) and Linear identifier (ENG-412) in it is one those
//   Items carry (a pull request "finishing ENG-412" needs a finishes Link to it);
// - every count of pull requests, reviews or issues is one the facts give, and every number of days
//   or weeks is an age the facts give (or the range's length);
// - every other Person it names (by name or @login) is on the work it cites;
// - it neither ranks nor judges anyone ("top contributor", "deserves", "lazy"): the People view never
//   ranks or compares People.
// At most two sentences are kept; with none left, there is no paragraph and the card shows its facts.
// The card's own facts are always Commander's, beside it, so the paragraph never hides what must show.
import {
  githubIdentifier,
  type Item,
  type OversightRangeSpan,
  type Person,
  type PersonWeek,
  type StuckReason,
} from '@commander/domain';
import { z } from 'zod';
import type { ItemStore } from '../item-store';
import type { PromptData } from './prompt';

const DAY = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 30;
const MAX_ITEM_TEXT = 1_600;
const ITEMS_BUDGET = 24_000;
const MAX_DESCRIPTION = 800;
const MAX_REVIEW = 200;
const MAX_SENTENCES = 2;
const MAX_SENTENCE = 300;

// The reply's sentences, each a claim with the refs it rests on (part of the summary job's reply).
export const sentence = z
  .object({ text: z.string().max(2_000), refs: z.array(z.string().max(20)).max(40).optional().default([]) })
  .nullable()
  .catch(null);
export type ParagraphOutput = { sentences: z.infer<typeof sentence>[] };

export type PersonItemRef = {
  ref: string;
  itemId: string;
  item: Item;
  // Issue and pull request numbers it carries (its own, its closing and linked issues).
  numbers: Set<number>;
  // Linear identifiers it carries: a Linear issue's own, a pull request's finishes Links.
  linear: Set<string>;
  // The GitHub logins and Linear user ids of the people on it (author, reviewers, asked, assignees).
  involved: Set<string>;
  // Ages in whole days the facts give for it (open, waiting, stuck, since merged or reviewed).
  days: Set<number>;
  kind: 'pull' | 'linear';
};

export type PersonMaterial = {
  week: PersonWeek;
  range: OversightRangeSpan;
  // The name the prompt calls them by: theirs when it looks like a name, else their login.
  name: string;
  items: Map<string, PersonItemRef>;
  refOf: Map<string, string>;
  // The facts block first, then the Items.
  data: PromptData[];
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
const wholeDays = (ms: number) => Math.max(0, Math.floor(ms / DAY));
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayOf = (at: number) => {
  const date = new Date(at);
  return `${DAY_NAMES[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
};

/** A name as the facts may say it: a few words of letters, else null (it may be words meant to steer). */
export function plainName(name: string): string | null {
  const one = oneLine(name);
  return /^[\p{L}][\p{L}\p{M}'’.-]*(?: [\p{L}][\p{L}\p{M}'’.-]*){0,3}$/u.test(one) && one.length <= 40
    ? one
    : null;
}
const plainLogin = (login: string) => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login);

function reasonWords(reason: StuckReason): string {
  switch (reason.kind) {
    case 'review-waiting': {
      const who = plainName(reason.name) ?? (plainLogin(reason.reviewer) ? reason.reviewer : 'a reviewer');
      return `waiting ${counted(reason.days, 'day')} on review from ${who}`;
    }
    case 'checks-failing':
      return 'its checks are failing';
    case 'idle':
      return `open ${counted(reason.openDays, 'day')} with no activity for ${counted(reason.idleDays, 'day')}`;
  }
}

/** What Ares reads about one Person's week: Commander's facts, then each Item of theirs on its own. */
export function gatherPersonMaterial(
  store: Pick<ItemStore, 'get' | 'githubOversight'>,
  week: PersonWeek,
  range: OversightRangeSpan,
): PersonMaterial {
  const now = range.to;
  const items = new Map<string, PersonItemRef>();
  const refOf = new Map<string, string>();
  const blocks: PromptData[] = [];
  let spent = 0;
  const login = week.logins.find(plainLogin);
  const name = plainName(week.name) ?? login ?? 'this person';

  const finishesOf = (itemId: string): string[] =>
    (store.get(itemId)?.links ?? [])
      .filter((link) => link.type === 'finishes' && link.to.kind === 'linear-issue')
      .flatMap((link) => {
        const linear = store.get(link.to.id)?.item;
        return linear?.detail?.kind === 'linear-issue' ? [linear.detail.identifier] : [];
      });

  function pullBlock(
    item: Item,
    finishes: string[],
  ): { text: string; label: string; ref: Partial<PersonItemRef> } {
    const detail = item.detail;
    if (detail?.kind !== 'pull-request') throw new Error('not a pull request');
    const writer = store.githubOversight.writerDetail(item.id);
    const state =
      detail.state === 'merged'
        ? `merged${detail.mergedAt ? ` on ${dayOf(detail.mergedAt)}` : ''}`
        : detail.state === 'closed'
          ? 'closed without merging'
          : detail.draft
            ? 'open, a draft'
            : 'open';
    const asked = detail.requestedReviewers.flatMap((each) =>
      each.kind === 'user' ? [each.login] : [each.team],
    );
    const lines = [
      `Pull request ${githubIdentifier(detail.repo, detail.number)}: ${item.title}`,
      `By ${detail.author ?? 'someone'}, opened ${dayOf(detail.createdAt)}, ${state}`,
      ...(asked.length ? [`Review asked of: ${asked.join(', ')}`] : []),
      ...(detail.reviews.length
        ? [`Reviews: ${detail.reviews.map((review) => `${review.login} (${review.state})`).join(', ')}`]
        : []),
      ...(finishes.length ? [`Finishes Linear issues: ${finishes.join(', ')}`] : []),
      ...(detail.closingIssues.length
        ? [`Closes: ${detail.closingIssues.map((ref) => githubIdentifier(ref, ref.number)).join(', ')}`]
        : []),
      `What changed: ${counted(detail.changedFiles, 'file')}, +${detail.additions} −${detail.deletions}`,
    ];
    const description = writer?.description ?? detail.body;
    if (description.trim()) lines.push(`Description:\n${cutKeepingLines(description, MAX_DESCRIPTION)}`);
    for (const review of writer?.reviews ?? [])
      if (review.body.trim())
        lines.push(`Review by ${review.author ?? 'someone'}: ${cut(review.body, MAX_REVIEW)}`);
    const numbers = new Set([detail.number]);
    for (const ref of [...detail.closingIssues, ...(writer?.linkedIssues ?? [])])
      if (ref.owner === detail.repo.owner && ref.name === detail.repo.name) numbers.add(ref.number);
    const involved = new Set(
      [
        detail.author,
        ...detail.assignees,
        ...detail.requestedReviewers.flatMap((each) => (each.kind === 'user' ? [each.login] : [])),
        ...detail.reviews.map((review) => review.login),
      ].flatMap((each) => (each ? [`github:${each.toLowerCase()}`] : [])),
    );
    return {
      text: cutKeepingLines(lines.join('\n'), MAX_ITEM_TEXT),
      label: `Pull request ${githubIdentifier(detail.repo, detail.number)}`,
      ref: { numbers, linear: new Set(finishes), involved, kind: 'pull' },
    };
  }

  function linearBlock(item: Item): { text: string; label: string; ref: Partial<PersonItemRef> } {
    const detail = item.detail;
    if (detail?.kind !== 'linear-issue') throw new Error('not a Linear issue');
    const lines = [
      `Linear issue ${detail.identifier}: ${item.title}`,
      `State: ${detail.state.name}`,
      ...(detail.description?.trim()
        ? [`Description:\n${cutKeepingLines(detail.description, MAX_DESCRIPTION / 2)}`]
        : []),
    ];
    const involved = new Set(
      [detail.assignee, detail.creator].flatMap((user) => (user ? [`linear:${user.id.toLowerCase()}`] : [])),
    );
    return {
      text: cutKeepingLines(lines.join('\n'), MAX_ITEM_TEXT),
      label: `Linear issue ${detail.identifier}`,
      ref: {
        numbers: new Set(),
        linear: new Set([detail.identifier.toUpperCase()]),
        involved,
        kind: 'linear',
      },
    };
  }

  // Gives an Item a block of its own (once), while it fits; its ref, or null.
  function refFor(itemId: string, days: number[]): string | null {
    const known = refOf.get(itemId);
    if (known) {
      for (const each of days) items.get(known)?.days.add(each);
      return known;
    }
    if (items.size >= MAX_ITEMS) return null;
    const item = store.get(itemId)?.item;
    if (!item || item.deletedAt !== null) return null;
    let block: ReturnType<typeof pullBlock>;
    if (item.detail?.kind === 'pull-request') block = pullBlock(item, finishesOf(item.id));
    else if (item.detail?.kind === 'linear-issue') block = linearBlock(item);
    else return null;
    if (spent + block.text.length > ITEMS_BUDGET) return null;
    spent += block.text.length;
    const ref = `I${items.size + 1}`;
    refOf.set(item.id, ref);
    items.set(ref, {
      numbers: new Set(),
      linear: new Set(),
      involved: new Set(),
      kind: 'pull',
      ...block.ref,
      ref,
      itemId: item.id,
      item,
      days: new Set(days),
    });
    blocks.push({ label: `${ref} · ${block.label}`, from: item, text: block.text });
    return ref;
  }

  const refsOf = (list: { itemId: string; at: number }[]) =>
    list.flatMap((each) => refFor(each.itemId, [wholeDays(now - each.at)]) ?? []);
  const list = (refs: string[], missing: number) =>
    `${refs.join(', ')}${missing ? ` (and ${missing} more not shown)` : ''}`;

  const lines = [
    `Facts about ${name}'s work in the watched GitHub repos from ${dayOf(range.from)} to ${dayOf(range.to)}, counted by Commander.`,
  ];
  const tally = (label: string, entries: { itemId: string; at: number }[], noun: string) => {
    if (!entries.length) {
      lines.push(`${label} no ${noun}s.`);
      return;
    }
    const refs = refsOf(entries);
    lines.push(`${label} ${counted(entries.length, noun)}: ${list(refs, entries.length - refs.length)}.`);
  };
  tally('Merged', week.merged, 'pull request');
  tally('Reviewed (someone else’s)', week.reviewed, 'pull request');
  tally('Opened', week.opened, 'pull request');
  if (week.open.length) {
    lines.push(`Open pull requests (${week.open.length}):`);
    for (const pull of week.open) {
      const days = [
        pull.openDays,
        ...pull.stuck.flatMap((reason) =>
          reason.kind === 'review-waiting'
            ? [reason.days]
            : reason.kind === 'idle'
              ? [reason.openDays, reason.idleDays]
              : [],
        ),
      ];
      const ref = refFor(pull.itemId, days);
      if (!ref) continue;
      lines.push(
        `- ${ref}, open ${counted(pull.openDays, 'day')}${pull.draft ? ', a draft' : ''}${
          pull.stuck.length ? `; stuck: ${and(pull.stuck.map(reasonWords))}` : ''
        }`,
      );
    }
  } else lines.push('No open pull requests.');
  if (week.waiting.length) {
    lines.push(`Reviews waiting on them (${week.waiting.length}):`);
    for (const wait of week.waiting) {
      const ref = refFor(wait.itemId, [wait.waitDays]);
      if (!ref) continue;
      const author = wait.author ? plainName(wait.author) : null;
      lines.push(`- ${ref}, asked ${counted(wait.waitDays, 'day')} ago${author ? `, by ${author}` : ''}`);
    }
  } else lines.push('No reviews waiting on them.');
  if (week.linear.length) {
    const refs = week.linear.flatMap((issue) => refFor(issue.itemId, []) ?? []);
    lines.push(
      `Open Linear issues assigned to them (${week.linear.length}): ${list(refs, week.linear.length - refs.length)}.`,
    );
  } else lines.push('No open Linear issues assigned to them.');

  return {
    week,
    range,
    name,
    items,
    refOf,
    data: [{ label: `F1 · Facts · ${name}`, from: 'user-settings', text: lines.join('\n') }, ...blocks],
  };
}

/** What Ares is asked: one or two plain sentences about the Person's week, never ranking or judging. */
export function personInstructions(material: PersonMaterial, now: number): string {
  return `You are Ares. You write one or two short sentences about one person's week in the GitHub repos the User watches, for the People view: what they worked on and where it stands, and what is waiting on them or for them, so the User can see who is stuck or overloaded. The User leads engineering. Write in your own plain, calm voice. Never rank, score, compare, praise or blame anyone: say what the work was and where it stands.

It is now ${dayOf(now)}. The week runs from ${dayOf(material.range.from)} to ${dayOf(material.range.to)}. The person is ${material.name}.

Each data block is labelled with its ref. F1 is Commander's facts about their week, naming the Items by their refs. I1, I2… are the Items themselves: pull requests (with their description and reviews) and Linear issues. Read them to understand the work.

Reply with only this JSON object: {"sentences":[{"text":"Priya spent the week on webhook retries.","refs":["F1","I2","I3"]}]}
- One or two sentences, each fewer than 30 words. Say what the work does rather than repeating titles.
- refs: every block the sentence rests on, exactly as labelled. A sentence with no refs is dropped.
- Use only numbers the facts give. Name another person only where they are on the Items the sentence names. Name a Linear issue only where a block says the pull request finishes it.
- State only what the blocks support.`;
}

// Upper-case team keys that are never Linear's.
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
const NUMBER_WORDS: Record<string, number> = {
  no: 0,
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
const NUMBER = `(\\d{1,4}|${Object.keys(NUMBER_WORDS).join('|')})`;
const COUNT = new RegExp(
  `\\b${NUMBER}\\s+(?:[a-z-]+\\s+)?(pull requests?|prs?|reviews?|issues?|tickets?)\\b`,
  'gi',
);
const DAYS = new RegExp(`\\b${NUMBER}\\s+(days?|weeks?)\\b`, 'gi');
// Words that rank or judge people; the People view never does either.
const JUDGING =
  /\b(top (?:contributor|performer|engineer)s?|best|worst|most productive|least productive|fastest|slowest|ranks?|ranked|ranking|leaderboard|mvp|star performer|outperform\w*|underperform\w*|lazy|slacking|slacker|deserves?|promot\w+|fired|firing|bonus|unreliable|incompetent)\b/i;

const numberOf = (word: string) => NUMBER_WORDS[word.toLowerCase()] ?? Number(word);
const sentenceOf = (text: string) => {
  const one = cut(text, MAX_SENTENCE);
  return /[.!?…]$/.test(one) ? one : `${one}.`;
};
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The paragraph that holds up, from Ares's sentences: at most two, each resting on blocks it was
 * handed and naming only numbers, issues, Linear issues and People those blocks carry. Null when none
 * does. Everything dropped is said, in plain words.
 */
export function acceptParagraph(
  output: ParagraphOutput,
  material: PersonMaterial,
  people: readonly Person[],
): { paragraph: { text: string; itemIds: string[] } | null; dropped: string[] } {
  const dropped: string[] = [];
  const kept: { text: string; itemIds: string[] }[] = [];
  const { week } = material;
  const all = [...material.items.values()];
  const subject = new Set([week.personId, week.key]);
  // Other People, by the names and logins a sentence might call them.
  const others = people
    .filter((each) => !subject.has(each.id))
    .map((each) => {
      const first = each.name.split(/\s+/)[0] ?? '';
      const ownFirst = week.name.split(/\s+/)[0] ?? '';
      const names = [each.name, ...(first.length >= 3 && first !== ownFirst ? [first] : [])].filter((name) =>
        plainName(name),
      );
      const handles = new Set(each.handles.map((handle) => handle.handle.toLowerCase()));
      const logins = [...handles].flatMap((handle) =>
        handle.startsWith('github:') ? [handle.slice('github:'.length)] : [],
      );
      const pattern = new RegExp(
        [
          ...names.map((name) => `(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`),
          ...logins.map((login) => `@${escapeRegExp(login)}(?![A-Za-z0-9-])`),
        ].join('|') || '(?!)',
        'u',
      );
      return { person: each, pattern, handles };
    });

  for (const raw of output.sentences) {
    if (kept.length >= MAX_SENTENCES) break;
    if (!raw?.text.trim()) {
      dropped.push('a sentence that wasn’t one');
      continue;
    }
    const text = sentenceOf(raw.text);
    const named = [...new Set(raw.refs.map((ref) => ref.trim().toUpperCase()))];
    const facts = named.includes('F1');
    const cited = named.flatMap((ref) => material.items.get(ref) ?? []);
    if (!facts && !cited.length) {
      dropped.push(`a sentence naming nothing it was given (${raw.refs.join(', ') || 'none'}): “${text}”`);
      continue;
    }
    // What it rests on: the Items it names, or (naming only the facts) every Item of theirs.
    const basis = cited.length ? cited : all;
    const problem = check(text, basis, facts || !cited.length);
    if (problem) {
      dropped.push(`a sentence ${problem}: “${text}”`);
      continue;
    }
    kept.push({ text, itemIds: cited.map((item) => item.itemId) });
  }
  if (!kept.length) return { paragraph: null, dropped };
  return {
    paragraph: {
      text: kept.map((each) => each.text).join(' '),
      itemIds: [...new Set(kept.flatMap((each) => each.itemIds))],
    },
    dropped,
  };

  // Why a sentence doesn't hold up against what it rests on; null when it does.
  function check(text: string, basis: PersonItemRef[], withFacts: boolean): string | null {
    if (JUDGING.test(text)) return 'that ranks or judges someone';
    const numbers = new Set(basis.flatMap((item) => [...item.numbers]));
    const stray = [...text.matchAll(ISSUE_NUMBER)].find((match) => !numbers.has(Number(match[1])));
    if (stray) return `naming ${stray[0]}, which nothing it rests on carries`;
    const linear = new Set(basis.flatMap((item) => [...item.linear]));
    const strayLinear = [...text.matchAll(LINEAR_ID)].find(
      (match) => !NOT_LINEAR.has(match[1] ?? '') && !linear.has(`${match[1]}-${match[2]}`),
    );
    if (strayLinear) return `naming ${strayLinear[0]}, which nothing it rests on carries`;

    // Counts: of pull requests and reviews, or of issues, as the facts give them.
    const pulls = basis.filter((item) => item.kind === 'pull').length;
    const issues = basis.filter((item) => item.kind === 'linear').length;
    const stuck = week.open.filter((pull) => pull.stuck.length).length;
    const pullCounts = new Set([pulls]);
    const issueCounts = new Set([issues]);
    if (withFacts) {
      for (const n of [week.merged, week.reviewed, week.opened, week.open, week.waiting].map(
        (each) => each.length,
      ))
        pullCounts.add(n);
      pullCounts.add(stuck);
      issueCounts.add(week.linear.length);
    }
    for (const match of text.matchAll(COUNT)) {
      const n = numberOf(match[1] ?? '');
      const noun = (match[2] ?? '').toLowerCase();
      const allowed = /^(issue|ticket)/.test(noun) ? issueCounts : pullCounts;
      if (!allowed.has(n)) return `claiming “${match[0]}”, which the facts don’t say`;
    }
    // Days and weeks: an age the facts give, or the range's length.
    const days = new Set(basis.flatMap((item) => [...item.days]));
    const span = (material.range.to - material.range.from) / DAY;
    for (const each of [Math.floor(span), Math.ceil(span), 7]) days.add(each);
    for (const match of text.matchAll(DAYS)) {
      const n = numberOf(match[1] ?? '');
      const weeks = (match[2] ?? '').toLowerCase().startsWith('week');
      const fits = weeks
        ? n === 1 || [...days].some((d) => Math.floor(d / 7) === n || Math.round(d / 7) === n)
        : days.has(n);
      if (!fits) return `claiming “${match[0]}”, which the facts don’t say`;
    }
    // Other People: only those on the work it rests on.
    const involved = new Set(basis.flatMap((item) => [...item.involved]));
    for (const other of others) {
      const found = other.pattern.exec(text);
      if (!found) continue;
      if (![...other.handles].some((handle) => involved.has(handle)))
        return `naming ${found[0]}, who isn’t on the work it rests on`;
    }
    return null;
  }
}
