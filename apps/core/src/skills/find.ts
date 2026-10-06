// Find (#192, decisions #24, #29): Ares looks things up in what Commander holds for the User, for a
// Conversation to answer from. Local only: the Item store's hybrid search (words and, once the
// embedding model is ready, meaning), People, the Daily Notes, Memory and the Updates he gave before.
//
// - Words: search with every word first; when that finds little, each meaningful word on its own, so
//   "acme redlines email" still finds the redlines. Meaning comes too when the query can be embedded.
// - Narrowing: a person (their Items, by every handle of theirs), a Project (its Items), kinds, and a
//   time ("today", "this week") judged by when each Item happened (an event's start, an email's
//   sending, else its last change). A person or Project Commander doesn't know is looked for as words.
// - Nothing to look for but a time (or a kind, or a Project): what's on then, the day's events, the
//   Todos due, the Daily Note's lines, and Items of those kinds changed then.
// - It reads what it finds (read-item.ts), at most a dozen Items, and brings what Ares knows about
//   them (confirmed as the User's, the rest as background), the People it names (as background:
//   their names come from Sources) and the lines of past Updates about it (as background: Ares
//   wrote them from outside content).
// - Never: a Gmail Account's mail before the User has allowed Ares to read it, tombstones, or Ares's
//   own meeting prep and GitHub summaries.
import {
  FIND_NEEDS,
  FIND_SKILL,
  type FindInput,
  findInput,
  type Item,
  type ItemKind,
  localDay,
  mayReadMail,
  normaliseHandle,
  type Person,
  type Project,
  type Skill,
} from '@commander/domain';
import { clockTime, cut } from '../agent/chat-material';
import { recall } from '../agent/memory-context';
import type { PromptData } from '../agent/prompt';
import type { ItemStore, QueryVector } from '../item-store';
import { type Findings, findable, KINDS_OF, type Range, rangeOf, timeOf } from './findings';
import { readItem } from './read-item';

// The most Items one Find reads.
export const FIND_LIMIT = 12;
const SEARCH_LIMIT = 60;
const PAST_LINES = 5;
const PEOPLE = 3;

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
// Words that say nothing about what to find.
const STOP = new Set(
  'a an and any are about all as at be by did do does for from had has have how i in is it its me my of on or our over please show tell that the their them there these this those to up was we were what when where which who why will with you your email emails mail message messages thread find look'.split(
    ' ',
  ),
);

/** The words of a text that say something about what to find. */
export function meaningfulWords(text: string): string[] {
  return [...new Set((text.match(WORD) ?? []).map((word) => word.toLowerCase()))].filter(
    (word) => word.length > 1 && !STOP.has(word),
  );
}

export type FindOptions = {
  itemStore: ItemStore;
  // The query embedded, when search by meaning is ready.
  meaning?: (text: string) => Promise<QueryVector | null>;
  now?: () => number;
};

const nameWords = (name: string) => (name.match(WORD) ?? []).map((word) => word.toLowerCase());

/** The Project the User means: its code, or a name with words starting with each word they used. */
export function projectNamed(projects: readonly Project[], words: string): Project | null {
  const typed = nameWords(words);
  if (!typed.length) return null;
  return (
    projects.find((project) => typed.length === 1 && typed[0] === project.code.toLowerCase()) ??
    projects.find((project) => {
      const named = nameWords(project.name);
      return typed.every((word) => named.some((name) => name.startsWith(word)));
    }) ??
    null
  );
}

/** The Person the User means: a name with words starting with each word they used, or a handle. */
export function personNamed(people: readonly Person[], words: string): Person | null {
  const typed = nameWords(words);
  const whole = words.trim().toLowerCase();
  if (!typed.length) return null;
  return (
    people.find((person) => {
      const named = nameWords(person.name);
      return typed.every((word) => named.some((name) => name.startsWith(word)));
    }) ??
    people.find((person) =>
      person.handles.some(({ handle }) => {
        const bare = handle.slice(handle.indexOf(':') + 1).toLowerCase();
        return handle.toLowerCase() === whole || bare === whole;
      }),
    ) ??
    null
  );
}

const inRange = (range: Range | null, at: number) => !range || (at >= range.from && at < range.to);

export function createFindSkill(options: FindOptions): Skill<FindInput, Findings> {
  const { itemStore } = options;
  const now = options.now ?? Date.now;

  const mayRead = (item: Item) => mayReadMail(itemStore.models.settings(), item.source, item.account);
  const projectCode = (projectId: string) =>
    itemStore.projects({ includeArchived: true }).find((project) => project.id === projectId)?.code ?? null;
  const emailText = (itemId: string) => itemStore.emailBody(itemId)?.text ?? null;

  async function find(input: FindInput): Promise<Findings> {
    const range = input.when ? rangeOf(input.when, now()) : null;
    const kinds: ItemKind[] | null = input.kinds?.length
      ? input.kinds.flatMap((kind) => KINDS_OF[kind])
      : null;
    const project = input.project ? projectNamed(itemStore.projects(), input.project) : null;
    const person = input.person ? personNamed(itemStore.people.list(), input.person) : null;
    // A Project or person Commander doesn't know is looked for as words.
    const asWords = [
      input.query ?? '',
      input.project && !project ? input.project : '',
      input.person && !person ? input.person : '',
    ]
      .filter(Boolean)
      .join(' ');
    const handles = new Set(person?.handles.map(({ handle }) => normaliseHandle(handle).toLowerCase()) ?? []);

    const wanted = (item: Item) =>
      findable(item, mayRead) &&
      (!kinds || kinds.includes(item.kind)) &&
      (!project || item.filing?.projectId === project.id) &&
      (!person || item.people.some((handle) => handles.has(normaliseHandle(handle).toLowerCase()))) &&
      inRange(range, timeOf(item));

    const found = new Map<string, Item>();
    const add = (items: Iterable<Item>) => {
      for (const item of items) if (!found.has(item.id) && wanted(item)) found.set(item.id, item);
    };

    const words = meaningfulWords(asWords);
    let people: Person[] = person ? [person] : [];
    const vector = words.length
      ? ((await options.meaning?.(words.join(' ')).catch(() => null)) ?? undefined)
      : undefined;
    if (words.length) {
      // A space at the end: whole words, not a prefix still being typed.
      const query = { kinds: kinds ?? undefined, projectId: project?.id, limit: SEARCH_LIMIT };
      const all = itemStore.search.query({ ...query, text: `${words.join(' ')} ` }, vector);
      add(all.hits.map((hit) => hit.item));
      if (!person) people = (all.people ?? []).filter((each) => !each.isUser).slice(0, PEOPLE);
      if (found.size < 3 && words.length > 1) {
        for (const word of words) {
          add(itemStore.search.query({ ...query, text: `${word} ` }).hits.map((hit) => hit.item));
        }
      }
    }
    if (person && !words.length) {
      add(itemStore.query({ people: [...handles], kinds: kinds ?? undefined, limit: 300 }));
    }
    if (!words.length && !person) {
      // What's on: the day's events, the Todos due, the Daily Notes' lines, and the rest changed then.
      const wants = (kind: ItemKind) => !kinds || kinds.includes(kind);
      if (range && wants('event')) {
        add(itemStore.events({ from: range.from, to: range.to }).sort((a, b) => timeOf(a) - timeOf(b)));
      }
      // Open Todos (due then, with a time).
      if (wants('todo')) add(itemStore.query({ kinds: ['todo'], statuses: ['open'], limit: 500 }));
      // The lines the User wrote in the Daily Notes of those days, whenever they wrote them.
      if (range && wants('block')) {
        const notes = itemStore.dailyNotes({
          from: localDay(range.from),
          to: localDay(range.to - 1),
          withContent: true,
        }).notes;
        for (const block of itemStore.blocks(notes.map((note) => note.item.id))) {
          if (block.detail?.kind !== 'block' || !block.detail.text.trim() || found.has(block.id)) continue;
          if (findable(block, mayRead) && (!project || block.filing?.projectId === project.id))
            found.set(block.id, block);
        }
      }
      // Items of the kinds asked for, or a Project's, changed then; never all of everything changed today.
      const others = (kinds ?? []).some((kind) => !['event', 'todo', 'block', 'daily-note'].includes(kind));
      if (others || !range || project) {
        add(itemStore.query({ kinds: kinds ?? undefined, projectId: project?.id, limit: 300 }));
      }
    }

    const items = [...found.values()].slice(0, FIND_LIMIT);
    const more: PromptData[] = [];
    const about = [words.join(' '), person?.name ?? '', project?.name ?? ''].filter(Boolean).join(' ');
    if (about) {
      more.push(
        ...recall(itemStore, {
          text: about,
          handles: [...handles],
          projectIds: project ? [project.id] : undefined,
          limit: 6,
          meaning: vector,
        }),
      );
    }
    if (people.length) {
      more.push({
        label: 'People Commander knows',
        from: { background: [] },
        text: people
          .map(
            (each) =>
              `- ${each.name}: ${each.handles
                .map(({ handle }) => handle)
                .slice(0, 6)
                .join(', ')}`,
          )
          .join('\n'),
      });
    }
    more.push(...pastUpdates(words, range));

    const parts = [
      words.length ? `the words “${words.join(' ')}”` : null,
      person ? `Items involving the person “${input.person}”` : null,
      project ? `the Project ${project.name} (${project.code})` : null,
      input.kinds?.length ? `only ${input.kinds.join(', ')}` : null,
      range ? range.words : null,
    ].filter(Boolean);
    const total = found.size;
    const note = `Find looked for ${parts.join(', ')}: ${
      total === 0
        ? 'nothing in Commander matches'
        : `${total} Item${total === 1 ? '' : 's'}${total > items.length ? `, the ${items.length} best read here` : ''}`
    }.${input.project && !project ? ` No Project is called “${input.project}”, so it was looked for as words.` : ''}${
      input.person && !person
        ? ` Commander knows no one called “${input.person}”, so it was looked for as words.`
        : ''
    }`;
    return {
      note,
      items: items.map((item) => ({ item, text: readItem(item, { emailText, projectCode }) })),
      more,
    };
  }

  // The lines of the Updates he gave before that are about these words (or given in this time).
  function pastUpdates(words: readonly string[], range: Range | null): PromptData[] {
    if (!words.length && !range) return [];
    const lines: { at: number; text: string; itemIds: string[]; score: number }[] = [];
    for (const update of itemStore.updates.history(50)) {
      if (!inRange(range, update.at)) continue;
      for (const line of update.lines) {
        const text = line.text.toLowerCase();
        const score = words.length ? words.filter((word) => text.includes(word)).length : 1;
        if (score > 0) lines.push({ at: update.at, text: line.text, itemIds: line.itemIds, score });
      }
    }
    return lines
      .sort((a, b) => b.score - a.score || b.at - a.at)
      .slice(0, PAST_LINES)
      .map((line) => ({
        label: `Past Update, ${localDay(line.at)} ${clockTime(line.at)}`,
        from: {
          background: line.itemIds.flatMap((itemId) => {
            const item = itemStore.get(itemId)?.item;
            return item ? [item] : [];
          }),
        },
        text: cut(line.text, 600),
      }));
  }

  return { ...FIND_SKILL, input: { schema: findInput, describe: FIND_NEEDS }, run: find };
}
