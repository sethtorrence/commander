import {
  type ActionKind,
  UPDATE_SECTION_NAMES,
  type UpdateSection,
  type UpdatesRequest,
  type UpdatesResults,
  type UpdateViewLine,
} from '@commander/domain';

/** What the window may ask of Ares's Updates (window.commander.updates). */
export type UpdatesClient = <R extends UpdatesRequest>(request: R) => Promise<UpdatesResults[R['op']]>;

// Accepted in bulk only where the gate allows it (Organise and Tidy your Sources).
const BULK: readonly ActionKind[] = ['organise', 'tidy-sources'];

const isQueued = (line: UpdateViewLine) => line.queued?.status === 'queued';

/** The label of a line's Accept, or null when there is nothing to accept on it in place. */
export function acceptLabel(line: UpdateViewLine): string | null {
  if (!isQueued(line)) return null;
  const about = line.queued?.about;
  switch (about?.kind) {
    case 'suggestions': {
      const count = about.proposalIds.length;
      if (count === 1) return 'Accept';
      return BULK.includes(about.actionKind) ? `Accept all ${count}` : null;
    }
    case 'chained':
      return 'Accept';
    case 'autonomy-change':
      return 'Yes, just do them';
    default:
      return null;
  }
}

export type OpenTarget =
  | { kind: 'item'; sectionId: string; itemId: string }
  | { kind: 'section'; sectionId: string }
  | { kind: 'settings' };

// Sections with a tab of their own; Teams follows in its milestone.
const OPENABLE: readonly UpdateSection[] = [
  'notes',
  'todos',
  'linear',
  'email',
  'calendar',
  'github',
  'ares',
];
const sectionOf = (section: UpdateSection) => (OPENABLE.includes(section) ? section : 'ares');

/** Where Open takes the User: the one Item a line is about, else where its Items are. */
export function openTarget(line: UpdateViewLine): OpenTarget {
  const about = line.queued?.about;
  if (about?.kind === 'cap-warning' || about?.kind === 'autonomy-change') return { kind: 'settings' };
  const first = line.itemIds[0];
  const single = line.itemIds.length === 1 || about?.kind === 'chained';
  if (first && single) return { kind: 'item', sectionId: sectionOf(line.section), itemId: first };
  if (about?.kind === 'suggestions') return { kind: 'section', sectionId: 'ares' };
  return { kind: 'section', sectionId: sectionOf(line.section) };
}

/** "and 23 smaller things", with how many in each Section. */
export function foldedSummary(lines: readonly UpdateViewLine[]) {
  const folded = lines.filter((line) => line.folded);
  const counts = new Map<UpdateSection, number>();
  for (const line of folded) counts.set(line.section, (counts.get(line.section) ?? 0) + 1);
  return {
    count: folded.length,
    text: `and ${folded.length} smaller thing${folded.length === 1 ? '' : 's'}`,
    bySection: [...counts]
      .map(([section, count]) => ({ section, name: UPDATE_SECTION_NAMES[section], count }))
      .sort((a, b) => b.count - a.count),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (at: number) => {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** What became of a line since Ares gave it, or null while it waits. */
export function lineStatus(line: UpdateViewLine, now: number): string | null {
  const queued = line.queued;
  if (!queued) return 'No longer needed';
  switch (queued.status) {
    case 'done':
    case 'resolved':
      return 'Done';
    case 'dismissed':
      return 'Dismissed';
    case 'expired':
      return 'No longer needed';
  }
  if (queued.snoozedUntil !== null && queued.snoozedUntil > now) {
    return `Snoozed till ${sameDay(queued.snoozedUntil, now) ? '' : 'tomorrow '}${hhmm(queued.snoozedUntil)}`;
  }
  return null;
}
