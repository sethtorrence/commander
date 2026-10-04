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
    // Opens the Rule editor, filled in (#71).
    case 'rule-suggestion':
      return 'Make the Rule…';
    default:
      return null;
  }
}

export type OpenTarget =
  | { kind: 'item'; sectionId: string; itemId: string }
  | { kind: 'section'; sectionId: string }
  // `part`: where in Settings (Accounts, for an Account to reconnect).
  | { kind: 'settings'; part?: 'accounts' };

// Sections with a tab of their own.
const OPENABLE: readonly UpdateSection[] = [
  'notes',
  'todos',
  'linear',
  'email',
  'calendar',
  'github',
  'teams',
  'ares',
];
const sectionOf = (section: UpdateSection) => (OPENABLE.includes(section) ? section : 'ares');

/**
 * Where Open takes the User: the one Item a line is about, else where its Items are. `itemId`: one
 * of the line's Items in particular (an issue of a merged Linear line).
 */
export function openTarget(line: UpdateViewLine, itemId?: string): OpenTarget {
  const about = line.queued?.about;
  if (itemId && line.itemIds.includes(itemId))
    return { kind: 'item', sectionId: sectionOf(line.section), itemId };
  if (about?.kind === 'cap-warning' || about?.kind === 'autonomy-change' || about?.kind === 'rule-suggestion')
    return { kind: 'settings' };
  if (about?.kind === 'reconnect') return { kind: 'settings', part: 'accounts' };
  const first = line.itemIds[0];
  const single = line.itemIds.length === 1 || about?.kind === 'chained';
  if (first && single) return { kind: 'item', sectionId: sectionOf(line.section), itemId: first };
  if (about?.kind === 'suggestions') return { kind: 'section', sectionId: 'ares' };
  return { kind: 'section', sectionId: sectionOf(line.section) };
}

/**
 * The Linear issues a merged line is about, each with what Ares said of it (why it left the User's
 * list, or why it looks stuck), to open one by one. Empty for a line about one issue (Open opens it)
 * and once the line has been acted on.
 */
export function lineIssues(line: UpdateViewLine): { itemId: string; identifier: string; text: string }[] {
  if (!isQueued(line)) return [];
  const about = line.queued?.about;
  const issues =
    about?.kind === 'linear-left'
      ? about.issues.map(({ itemId, identifier, why }) => ({ itemId, identifier, text: why }))
      : about?.kind === 'linear-stuck'
        ? about.issues.map(({ itemId, identifier, reason }) => ({ itemId, identifier, text: reason }))
        : [];
  return issues.length > 1 ? issues : [];
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
