// How an Update line names things (#186): an Item by its Source's short name and its title, where it
// lives, counts, days and times, all in plain words and all from Commander's own data, so a template
// never needs the model and every name, number and date in it can be checked.
import type { Item, ItemKind, Source, UpdateSection } from '@commander/domain';

export const SECTION_OF_KIND: Partial<Record<ItemKind, UpdateSection>> = {
  'linear-issue': 'linear',
  email: 'email',
  event: 'calendar',
  'pull-request': 'github',
  'review-request': 'github',
  'github-issue': 'github',
  'github-release': 'github',
  'github-summary': 'github',
  chat: 'teams',
  'channel-post': 'teams',
  todo: 'todos',
  block: 'notes',
  'daily-note': 'notes',
  'meeting-prep': 'calendar',
};

export const SOURCE_NAMES: Record<Source, string> = {
  linear: 'Linear',
  gmail: 'Gmail',
  outlook: 'Outlook',
  'google-calendar': 'Google Calendar',
  'outlook-calendar': 'Outlook Calendar',
  teams: 'Teams',
  github: 'GitHub',
};

/** One line, spaces collapsed. */
export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Cut to a length, with an ellipsis when cut. */
export const cut = (text: string, length: number) => {
  const one = oneLine(text);
  return one.length > length ? `${one.slice(0, length - 1).trimEnd()}…` : one;
};

/** One sentence as said: on one line, ending with a full stop (or its own mark). */
export const sentence = (text: string) => {
  const one = oneLine(text);
  return /[.!?…”]$/.test(one) ? one : `${one}.`;
};

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Where an Item lives, as a Section of Commander. */
export const sectionOf = (item: Item | null | undefined): UpdateSection =>
  (item && SECTION_OF_KIND[item.kind]) || 'ares';

/** The Source's short name for an Item, when it has one: ENG-418, acme/api#12. */
export function labelOf(item: Item): string | null {
  const { detail } = item;
  if (detail?.kind === 'linear-issue') return detail.identifier;
  if (detail?.kind === 'pull-request' || detail?.kind === 'github-issue')
    return `${detail.repo.owner}/${detail.repo.name}#${detail.number}`;
  return null;
}

/** An Item's title on one line, cut to fit a sentence. */
export const titleOf = (item: Item) => cut(item.title, 90) || 'Untitled';

/** An Item by name: `ENG-418 “Throttle bursts on /sync”`, `“Titanlink eng”`. */
export function nameOf(item: Item): string {
  const label = labelOf(item);
  return label ? `${label} “${titleOf(item)}”` : `“${titleOf(item)}”`;
}

/** The Source an Item came from, as the User knows it, or null for Items made in Commander. */
export const sourceOf = (item: Item): string | null => (item.source ? SOURCE_NAMES[item.source] : null);

/** Where an Item is, in a few words: "in Linear", "on GitHub", "in your notes". */
export function whereOf(item: Item): string {
  if (item.source === 'github') return 'on GitHub';
  const source = sourceOf(item);
  if (source) return `in ${source}`;
  if (item.kind === 'block' || item.kind === 'daily-note') return 'in your notes';
  if (item.kind === 'todo') return 'in your Todos';
  return 'in Commander';
}

/** An Item by name and where it is: `ENG-418 “Throttle bursts on /sync” in Linear`. */
export const namedWhere = (item: Item) => `${nameOf(item)} ${whereOf(item)}`;

/** "A", "A and B", "A, B and C", "A, B, C and 4 more". */
export function listed(names: readonly string[], max = 3): string {
  const shown = names.slice(0, max);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  if (shown.length <= 1) return shown[0] ?? '';
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
}

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = [
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
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "15:00", in the User's local time. */
export const clock = (at: number) => {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** "23 Sep". */
export const dayMonth = (at: number) => {
  const date = new Date(at);
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
};

/** "1 November": the first day of the month after `at`'s. */
export const nextMonthStart = (at: number) => {
  const date = new Date(at);
  return `1 ${LONG_MONTHS[(date.getMonth() + 1) % 12]}`;
};

const startOfDay = (at: number) => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** "today", "tomorrow", or "on Thu 8 Oct". */
export function dayWord(at: number, now: number): string {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `on ${WEEKDAYS[new Date(at).getDay()]} ${dayMonth(at)}`;
}

/** Whole days between two moments, at least 1: "12 days", "1 day". */
export const daysSince = (at: number, now: number) =>
  plural(Math.max(1, Math.floor((now - at) / DAY)), 'day');
