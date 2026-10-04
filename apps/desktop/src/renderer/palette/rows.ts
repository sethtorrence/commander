import {
  type Filing,
  gmailSearchUrl,
  type Person,
  type Project,
  type SearchHit,
  type SearchResult,
} from '@commander/domain';
import { handleSourceName } from '../people/people';
import { dateOf } from '../sections/notes/days';
import { kindTag } from '../sections/todos/links';
import type { Command } from './commands';
import type { PaletteQuery } from './query';

/*
  What the palette lists for its input, as groups of rows after the prototype's jump palette
  (a tag, the label, a hint on the right):

  - Jump: Sections and today's Daily Note; then Projects (their pages); then People (#117), which
    open Settings → People at the Person until the People view gives them a page
  - search results grouped by kind, the group holding the best hit first
  - Commands
  - Search in Linear, last, when local results are thin and a Linear Account is connected
  - Search in Gmail (#135), one row per email Account, when emails are among the results: Commander
    keeps only the 30 days before an Account was connected and what came since

  Before anything is typed it offers Jump, Projects and Commands. Once chips narrow the search to
  Items (`/` in a Section), only results show.
*/

export type PaletteAction =
  | { type: 'section'; sectionId: string }
  | { type: 'today' }
  | { type: 'project'; projectId: string }
  | { type: 'person'; personId: string }
  | { type: 'item'; hit: SearchHit }
  | { type: 'command'; command: Command }
  | { type: 'browser'; url: string };

export interface PaletteRow {
  key: string;
  tag: string;
  label: string;
  hint: string;
  /** Shown as a Badge: the Item's filing, or the Project's own. */
  filing?: Filing;
  action: PaletteAction;
}

export interface PaletteGroup {
  title: string;
  rows: PaletteRow[];
}

export interface PaletteContext {
  query: PaletteQuery;
  /** The Core's answer for `query.search`, or null when there is none (yet). */
  result: SearchResult | null;
  sections: readonly { id: string; label: string; code: string }[];
  /** The open Section's id. */
  current: string;
  projects: readonly Project[];
  commands: readonly Command[];
  linearAccounts: readonly { name: string; urlKey: string }[];
  /** The email Accounts with Gmail on, for Gmail's own search. */
  gmailAccounts?: readonly { email: string }[];
  /** Today, YYYY-MM-DD. */
  today: string;
}

/** Fewer local hits than this, and the palette offers each Source's own search. */
export const THIN_RESULTS = 3;

const WORD = /[\p{L}\p{N}]+/gu;
const wordsOf = (text: string) => (text.match(WORD) ?? []).map((word) => word.toLowerCase());
const pad = (n: number) => String(n).padStart(2, '0');
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Wed 30 Sep" */
function shortDay(day: string): string {
  const date = dateOf(day);
  return `${SHORT_DAYS[date.getDay()]} ${date.getDate()} ${SHORT_MONTHS[date.getMonth()]}`;
}

// Whether every word typed starts a word of the row's text.
function matches(typed: string[], text: string): boolean {
  const words = wordsOf(text);
  return typed.every((word) => words.some((candidate) => candidate.startsWith(word)));
}

// Where results of each kind are grouped, and the group's title.
const GROUP_OF: Record<string, string> = {
  todo: 'Todos',
  block: 'Notes',
  'daily-note': 'Notes',
  'linear-issue': 'Linear',
  email: 'Email',
  event: 'Calendar',
  'pull-request': 'GitHub',
  'review-request': 'GitHub',
  'github-issue': 'GitHub',
  'github-release': 'GitHub',
  chat: 'Teams',
  'channel-post': 'Teams',
};

function hitRow(hit: SearchHit, today: string): PaletteRow {
  const { item } = hit;
  const row = { key: `item:${item.id}`, label: item.title, filing: item.filing ?? undefined };
  const action: PaletteAction = { type: 'item', hit };
  const detail = item.detail;
  switch (item.kind) {
    case 'linear-issue': {
      const issue = detail?.kind === 'linear-issue' ? detail : null;
      return { ...row, tag: issue?.identifier ?? 'LIN', hint: issue?.state.name ?? 'Linear', action };
    }
    case 'pull-request':
    case 'github-issue': {
      const found = detail?.kind === 'pull-request' || detail?.kind === 'github-issue' ? detail : null;
      const tag = found ? `${found.repo.name}#${found.number}` : kindTag(item.kind);
      return { ...row, tag, hint: 'GitHub', action };
    }
    case 'todo': {
      const dueOn = detail?.kind === 'todo' ? detail.dueOn : null;
      const tag = item.status === 'done' ? 'Done' : dueOn ? `Due ${shortDay(dueOn)}` : 'Todo';
      return { ...row, tag, hint: 'Todos', action };
    }
    case 'block': {
      const tag = hit.day === today ? 'Today' : hit.day ? shortDay(hit.day) : 'Block';
      return { ...row, label: item.title || 'Empty Block', tag, hint: 'Daily Note', action };
    }
    case 'daily-note':
      return { ...row, tag: hit.day === today ? 'Today' : 'Daily Note', hint: 'Notes', action };
    default:
      return { ...row, tag: kindTag(item.kind), hint: GROUP_OF[item.kind] ?? item.kind, action };
  }
}

function projectRow(project: Project): PaletteRow {
  return {
    key: `project:${project.id}`,
    tag: project.code,
    label: project.name,
    hint: 'Project page',
    filing: { projectId: project.id, filedBy: 'user' },
    action: { type: 'project', projectId: project.id },
  };
}

function personRow(person: Person): PaletteRow {
  const sources = [...new Set(person.handles.map((each) => handleSourceName(each.source)))];
  return {
    key: `person:${person.id}`,
    tag: person.isUser ? 'You' : 'Person',
    label: person.name,
    hint: sources.join(' · '),
    action: { type: 'person', personId: person.id },
  };
}

export function paletteGroups(context: PaletteContext): PaletteGroup[] {
  const { query, result } = context;
  const groups: PaletteGroup[] = [];
  const add = (title: string, rows: PaletteRow[]) => {
    if (rows.length) groups.push({ title, rows });
  };
  const typed = wordsOf(query.text);
  const scoped = query.chips.length > 0;
  if (scoped && !query.search) return [];

  if (!scoped) {
    const jump: PaletteRow[] = context.sections.map((section, index) => ({
      key: `section:${section.id}`,
      tag: `${pad(index + 1)} · ${section.code}`,
      label: section.label,
      hint: section.id === context.current ? 'Here' : 'Section',
      action: { type: 'section', sectionId: section.id },
    }));
    jump.push({
      key: 'today',
      tag: 'Today',
      label: 'Today’s Daily Note',
      hint: 'Notes',
      action: { type: 'today' },
    });
    add(
      'Jump',
      jump.filter((row) => matches(typed, `${row.label} ${row.hint === 'Notes' ? 'daily note notes' : ''}`)),
    );
    add('Projects', (query.search ? (result?.projects ?? []) : context.projects).map(projectRow));
    if (query.search) add('People', (result?.people ?? []).map(personRow));
  }

  if (query.search && result) {
    const byGroup = new Map<string, PaletteRow[]>();
    for (const hit of result.hits) {
      const title = GROUP_OF[hit.item.kind] ?? kindTag(hit.item.kind);
      byGroup.set(title, [...(byGroup.get(title) ?? []), hitRow(hit, context.today)]);
    }
    for (const [title, rows] of byGroup) add(title, rows);
  }

  if (!scoped) {
    add(
      'Commands',
      context.commands
        .filter((command) => matches(typed, command.label))
        .map((command) => ({
          key: `command:${command.label}`,
          tag: command.keys ?? 'Cmd',
          label: command.label,
          hint: 'Command',
          action: { type: 'command', command },
        })),
    );
  }

  const sectionChips = query.chips.flatMap((chip) => (chip.type === 'section' ? [chip.sectionId] : []));
  const linearInScope = !sectionChips.length || sectionChips.includes('linear');
  const words = query.text.trim();
  if (words && result && result.hits.length < THIN_RESULTS && linearInScope) {
    add(
      'Search in Linear',
      context.linearAccounts.map((account) => ({
        key: `linear-search:${account.urlKey}`,
        tag: 'Linear',
        label: `Search “${words}” in Linear`,
        hint: `${account.name} ↗`,
        action: {
          type: 'browser',
          url: `https://linear.app/${encodeURIComponent(account.urlKey)}/search?q=${encodeURIComponent(words)}`,
        },
      })),
    );
  }
  const emailInScope = !sectionChips.length || sectionChips.includes('email');
  if (words && result?.hits.some((hit) => hit.item.kind === 'email') && emailInScope) {
    add(
      'Search in Gmail',
      (context.gmailAccounts ?? []).map((account) => ({
        key: `gmail-search:${account.email}`,
        tag: 'Gmail',
        label: `Search “${words}” in Gmail`,
        hint: `${account.email} ↗`,
        action: { type: 'browser', url: gmailSearchUrl(account.email, words) },
      })),
    );
  }
  return groups;
}
