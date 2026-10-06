import {
  type ActionKind,
  SCHEDULED_FOCUS,
  SEND_LATER_EDIT_FOCUS,
  SORT_INTO_BUCKETS,
  UNSORTED,
  UPDATE_SECTION_NAMES,
  type UpdateRow,
  type UpdateRowAction,
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
    case 'bucket-rule-suggestion':
      return 'Make the Rule…';
    // Opens the Bucket, filled in and editable (#141).
    case 'bucket-suggestion':
      return 'Add Bucket…';
    default:
      return null;
  }
}

export type OpenTarget =
  // `focus`: where in the Item to open it (Reply: the Chat's message waiting on the User).
  | { kind: 'item'; sectionId: string; itemId: string; focus?: string }
  // `focus`: where in the Section (the Email Section's Unsorted view, #141).
  | { kind: 'section'; sectionId: string; focus?: string }
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
/** The Section tab an Item of this Section opens in (the Ares Section for what has no tab). */
export const sectionOf = (section: UpdateSection) => (OPENABLE.includes(section) ? section : 'ares');

/**
 * Where Open takes the User: one of the line's Items where it lives (`row`; Reply opens a Chat at the
 * message waiting on the User), else the one Item a line is about, else where its Items are. A missed
 * send-later (#139) opens Scheduled, and its Edit opens the message in the composer.
 */
export function openTarget(
  line: UpdateViewLine,
  row?: UpdateRow,
  { reply = false, edit = false } = {},
): OpenTarget {
  const about = line.queued?.about;
  if (about?.kind === 'missed-send') {
    if (edit && row)
      return { kind: 'item', sectionId: 'email', itemId: row.itemId, focus: SEND_LATER_EDIT_FOCUS };
    return { kind: 'section', sectionId: 'email', focus: SCHEDULED_FOCUS };
  }
  if (row) {
    return {
      kind: 'item',
      sectionId: sectionOf(row.section),
      itemId: row.itemId,
      ...(reply && row.focus ? { focus: row.focus } : {}),
    };
  }
  if (
    about?.kind === 'cap-warning' ||
    about?.kind === 'autonomy-change' ||
    about?.kind === 'rule-suggestion' ||
    about?.kind === 'bucket-rule-suggestion' ||
    about?.kind === 'bucket-suggestion'
  )
    return { kind: 'settings' };
  if (about?.kind === 'reconnect') return { kind: 'settings', part: 'accounts' };
  const first = line.itemIds[0];
  const single = line.itemIds.length === 1 || about?.kind === 'chained';
  if (first && single) return { kind: 'item', sectionId: sectionOf(line.section), itemId: first };
  // "12 emails I wasn't sure about" (#141): the Unsorted view, where they wait first.
  if (about?.kind === 'suggestions' && about.action === SORT_INTO_BUCKETS)
    return { kind: 'section', sectionId: 'email', focus: UNSORTED };
  if (about?.kind === 'suggestions') return { kind: 'section', sectionId: 'ares' };
  return { kind: 'section', sectionId: sectionOf(line.section) };
}

// A line with more Items than this shows them folded, under the line's own count.
export const ROWS_SHOWN = 3;

/** A line's Items as the panel lists them, and whether they start folded (when there are many). */
export function lineRows(line: UpdateViewLine): { rows: UpdateRow[]; folded: boolean } {
  const rows = line.rows ?? [];
  return { rows, folded: rows.length > ROWS_SHOWN };
}

export const ROW_ACTION_LABELS: Record<UpdateRowAction, string> = {
  open: 'Open',
  reply: 'Reply',
  accept: 'Accept',
  dismiss: 'Dismiss',
  tick: 'Tick',
  'not-an-instruction': 'Not an instruction',
  'send-now': 'Send now',
  edit: 'Edit',
  discard: 'Discard',
};

/** How a row names its Item: its Source's short name, or its title. */
export const rowName = (row: UpdateRow) => row.label ?? row.title;

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
