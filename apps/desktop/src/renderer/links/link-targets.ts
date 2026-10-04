import { type BlockLinkTarget, clockOf, type Item, isEvent, localDay, type Project } from '@commander/domain';
import { addDays, dateOf, dayKey } from '../sections/notes/days';

/*
  What the `[[` picker offers: the things a Block can link to, each from a provider: Daily Notes (days),
  Projects and calendar events (#128); Linear issues, emails and PRs join as providers when their
  Sources arrive, each turning what the User typed into candidates.
*/

/** One thing the picker offers. */
export interface LinkCandidate {
  /** Unique across providers ("day:2026-10-03", "project:<id>"). */
  key: string;
  target: BlockLinkTarget;
  label: string;
  /** A second, quieter line: the date of "Today", "Archived" for an archived Project. */
  hint?: string;
  /** For a Project, to show its Badge. */
  project?: Project;
}

/** A source of link targets for the picker. */
export interface LinkTargetProvider {
  id: string;
  /** The picker's heading for its group: "Days". */
  label: string;
  /** Candidates for what was typed after `[[` (maybe nothing yet), best first. */
  search(query: string): LinkCandidate[];
}

export interface CandidateGroup {
  provider: LinkTargetProvider;
  candidates: LinkCandidate[];
}

/** Every provider's candidates for a query, in provider order, leaving out providers with none. */
export function searchTargets(providers: readonly LinkTargetProvider[], query: string, perGroup = 6) {
  const groups: CandidateGroup[] = [];
  for (const provider of providers) {
    const candidates = provider.search(query.trim()).slice(0, perGroup);
    if (candidates.length) groups.push({ provider, candidates });
  }
  return groups;
}

// ---- days ----

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const cap = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

// The words that name a day relative to today, in the order they are offered.
function dayWords(today: string): [word: string, day: string][] {
  const weekday = dateOf(today).getDay();
  // Monday first, each the most recent one (today included).
  const weekdays = [1, 2, 3, 4, 5, 6, 0].map((d): [string, string] => [
    WEEKDAYS[d] as string,
    addDays(today, -((weekday - d + 7) % 7)),
  ]);
  return [['today', today], ['yesterday', addDays(today, -1)], ['tomorrow', addDays(today, 1)], ...weekdays];
}

const monthOf = (word: string) =>
  word.length >= 3 ? MONTHS.findIndex((month) => month.startsWith(word.toLowerCase())) : -1;

// A real calendar day from its parts, or null ("31 Feb").
function dayOf(year: number, month: number, date: number): string | null {
  const made = new Date(year, month, date);
  if (made.getFullYear() !== year || made.getMonth() !== month || made.getDate() !== date) return null;
  return dayKey(made);
}

// An explicit date: 2026-10-09, "9 October", "9 oct 2025", "Oct 9", "October 9 2026".
function explicitDay(query: string, today: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(query);
  if (iso) return dayOf(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const year = dateOf(today).getFullYear();
  const dayFirst = /^(\d{1,2})\s+([a-z]+)\.?(?:\s+(\d{4}))?$/i.exec(query);
  const monthFirst = /^([a-z]+)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i.exec(query);
  const [date, month, inYear] = dayFirst
    ? [dayFirst[1], dayFirst[2], dayFirst[3]]
    : monthFirst
      ? [monthFirst[2], monthFirst[1], monthFirst[3]]
      : [];
  if (!date || !month) return null;
  const m = monthOf(month);
  return m < 0 ? null : dayOf(inYear ? Number(inYear) : year, m, Number(date));
}

/**
 * The days a query after `[[` can mean: today, yesterday, tomorrow and weekdays (the most recent one)
 * by any prefix, or an explicit date. Before anything is typed, today and yesterday.
 */
export function resolveDays(input: string, today: string): string[] {
  const query = input.trim().toLowerCase();
  if (!query) return [today, addDays(today, -1)];
  const explicit = explicitDay(query, today);
  if (explicit) return [explicit];
  return dayWords(today)
    .filter(([word]) => word.startsWith(query))
    .map(([, day]) => day);
}

/** "Sat 3 Oct", with the year when it isn't this one: "Thu 2 Jan 2025". */
export function shortDay(day: string, today: string): string {
  const date = dateOf(day);
  const name = `${cap(WEEKDAYS[date.getDay()] as string).slice(0, 3)} ${date.getDate()} ${cap(MONTHS[date.getMonth()] as string).slice(0, 3)}`;
  return date.getFullYear() === dateOf(today).getFullYear() ? name : `${name} ${date.getFullYear()}`;
}

/** Daily Notes: dates, today, yesterday, tomorrow and weekdays. */
export function dayTargets(today: string): LinkTargetProvider {
  return {
    id: 'days',
    label: 'Days',
    search(query) {
      const typed = query.trim().toLowerCase();
      const words = dayWords(today);
      return resolveDays(query, today).map((day) => {
        // Named by the word typed ("Thursday"), or Today and Yesterday before anything is typed.
        const word = words.find(([w, d]) => d === day && w.startsWith(typed))?.[0];
        const target: BlockLinkTarget = { type: 'day', day };
        return word
          ? { key: `day:${day}`, target, label: cap(word), hint: shortDay(day, today) }
          : { key: `day:${day}`, target, label: shortDay(day, today) };
      });
    },
  };
}

// ---- Projects ----

/** Projects by name or code, archived ones included (after the others). */
export function projectTargets(projects: readonly Project[]): LinkTargetProvider {
  return {
    id: 'projects',
    label: 'Projects',
    search(query) {
      const typed = query.trim().toLowerCase();
      const matches = projects.filter(
        (project) =>
          !typed ||
          project.name.toLowerCase().includes(typed) ||
          project.code.toLowerCase().startsWith(typed),
      );
      const ordered = [...matches].sort(
        (a, b) => Number(a.archived) - Number(b.archived) || a.order - b.order,
      );
      return ordered.map((project) => ({
        key: `project:${project.id}`,
        target: { type: 'project', projectId: project.id },
        label: project.name,
        ...(project.archived ? { hint: 'Archived' } : {}),
        project,
      }));
    },
  };
}

// ---- calendar events ----

/**
 * Calendar events by title: today's and upcoming ones first (soonest first), then earlier ones (latest
 * first). Before anything is typed, today's and upcoming ones. Cancelled events aren't offered.
 */
export function eventTargets(events: readonly Item[], today: string): LinkTargetProvider {
  const live = events.filter(isEvent).filter((event) => event.deletedAt === null);
  const dayName = (at: number) => {
    const day = localDay(at);
    return day === today ? 'Today' : shortDay(day, today);
  };
  return {
    id: 'events',
    label: 'Events',
    search(query) {
      const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const matching = live.filter((event) => {
        const title = event.title.toLowerCase();
        return words.every((word) => title.includes(word));
      });
      const coming = matching
        .filter((event) => localDay(event.detail.start.at) >= today)
        .sort((a, b) => a.detail.start.at - b.detail.start.at);
      const earlier = words.length
        ? matching
            .filter((event) => localDay(event.detail.start.at) < today)
            .sort((a, b) => b.detail.start.at - a.detail.start.at)
        : [];
      return [...coming, ...earlier].map((event) => ({
        key: `event:${event.id}`,
        target: { type: 'event', eventId: event.id },
        label: event.title,
        hint: `${dayName(event.detail.start.at)} ${event.detail.allDay ? '· All day' : clockOf(event.detail.start.at)}`,
      }));
    },
  };
}
