import type { ItemKind, Project, SearchQuery } from '@commander/domain';
import type { ProjectFilter } from '../projects/filter';

/*
  The palette's input: words to search for, and filter chips typed among them.

  - `#LT` a Project by its Badge code, `#unfiled` Unfiled Items
  - `in:notes` a Section that holds Items (Notes, Todos, Linear so far)
  - `@acme` an Account by its name, spaces left out
  - `after:2026-09-01`, `before:2026-10-01` (or `today`, `yesterday`): when Items last changed,
    by local day; after counts from the start of its day, before up to the start of its day

  A chip that names nothing known stays a word to search for, so "#hashtag" still finds notes.
*/

/**
 * The Item kinds each Section holds, for `in:` chips, the filter row and `/` in that Section. A
 * Section joins here once it holds Items (Email with `email`, Calendar with `event`, and so on).
 */
export const SECTION_KINDS: Readonly<Record<string, readonly ItemKind[]>> = {
  notes: ['block', 'daily-note'],
  todos: ['todo'],
  linear: ['linear-issue'],
};

export type Chip = { token: string; label: string } & (
  | { type: 'project'; projectId: string | null }
  | { type: 'section'; sectionId: string; kinds: readonly ItemKind[] }
  | { type: 'account'; accountId: string }
  | { type: 'after' | 'before'; at: number }
);

export interface QueryContext {
  projects: readonly Project[];
  accounts: readonly { id: string; name: string }[];
  now: Date;
}

export interface PaletteQuery {
  /** The words, without the chips. */
  text: string;
  chips: Chip[];
  /** What to ask the Core, or null when there are no words to search for. */
  search: SearchQuery | null;
}

const squash = (name: string) => name.replace(/\s+/g, '').toLowerCase();

function startOfDay(token: string, now: Date): number | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (token === 'today') return today.getTime();
  if (token === 'yesterday')
    return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(token);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  return date.getMonth() === month - 1 && date.getDate() === day ? date.getTime() : null;
}

function readChip(token: string, context: QueryContext): Chip | null {
  const lower = token.toLowerCase();
  if (lower.startsWith('#') && lower.length > 1) {
    const code = lower.slice(1);
    if (code === 'unfiled') return { type: 'project', token, label: 'Unfiled', projectId: null };
    const project = context.projects.find((p) => p.code.toLowerCase() === code);
    return project ? { type: 'project', token, label: project.code, projectId: project.id } : null;
  }
  if (lower.startsWith('in:')) {
    const sectionId = lower.slice(3);
    const kinds = SECTION_KINDS[sectionId];
    if (!kinds) return null;
    const label = sectionId.charAt(0).toUpperCase() + sectionId.slice(1);
    return { type: 'section', token, label, sectionId, kinds };
  }
  if (lower.startsWith('@') && lower.length > 1) {
    const account = context.accounts.find((a) => squash(a.name) === lower.slice(1));
    return account ? { type: 'account', token, label: account.name, accountId: account.id } : null;
  }
  const date = /^(after|before):(.+)$/.exec(lower);
  if (date) {
    const at = startOfDay(date[2] as string, context.now);
    const type = date[1] as 'after' | 'before';
    return at === null ? null : { type, token, label: `${type} ${date[2]}`, at };
  }
  return null;
}

export function readQuery(input: string, context: QueryContext): PaletteQuery {
  const chips: Chip[] = [];
  const words: string[] = [];
  for (const token of input.split(/\s+/).filter(Boolean)) {
    const chip = readChip(token, context);
    if (chip) chips.push(chip);
    else words.push(token);
  }
  const text = words.join(' ') + (words.length && /\s$/.test(input) ? ' ' : '');
  if (!text.trim()) return { text: '', chips, search: null };

  const search: SearchQuery = { text };
  const kinds = [...new Set(chips.flatMap((chip) => (chip.type === 'section' ? chip.kinds : [])))];
  if (kinds.length) search.kinds = kinds;
  const accounts = [...new Set(chips.flatMap((chip) => (chip.type === 'account' ? [chip.accountId] : [])))];
  if (accounts.length) search.accounts = accounts;
  for (const chip of chips) {
    if (chip.type === 'project') search.projectId = chip.projectId;
    if (chip.type === 'after') search.from = chip.at;
    if (chip.type === 'before') search.to = chip.at;
  }
  return { text, chips, search };
}

/** What `/` puts in the palette in a Section: its `in:` chip and the Project filter's, ready to type after. */
export function scopeFor(sectionId: string, filter: ProjectFilter, projects: readonly Project[]): string {
  const chips: string[] = [];
  if (SECTION_KINDS[sectionId]) chips.push(`in:${sectionId}`);
  if (filter === 'unfiled') chips.push('#unfiled');
  else if (filter !== 'everything') {
    const project = projects.find((p) => p.id === filter);
    if (project) chips.push(`#${project.code}`);
  }
  return chips.length ? `${chips.join(' ')} ` : '';
}

/** The input with a chip added in front, or taken out if it is already there (in any case). */
export function toggleChip(input: string, chip: string): string {
  const tokens = input.split(/\s+/).filter(Boolean);
  const kept = tokens.filter((token) => token.toLowerCase() !== chip.toLowerCase());
  if (kept.length !== tokens.length) return kept.join(' ') + (kept.length && /\s$/.test(input) ? ' ' : '');
  return `${chip} ${input.trimStart()}`;
}
