import type { EventResponse, EventTime } from './calendar';
import { CANCEL_SEND_FIELD, DRAFT_FIELD, SEND_FIELD } from './email-compose';
import { ANSWER_NAMES, type InvitationAnswer } from './invitations';
import type { ItemKind, Source } from './items';
import { CREATE_FIELD, DELETE_FIELD } from './linear-send';

/*
  A change waiting to reach its Source (or that couldn't sync), in Commander's own words (#206), from
  the change's data alone: Settings → Accounts lists it as "Move to In Review", and the Update says
  "moving ENG-418 to In Review". Names, states and labels come from the change's value (or the value
  the Source last had, for something taken away), never from anything else, so the words can be
  checked against the queue.
*/

export const SOURCE_NAME_OF: Record<Source, string> = {
  linear: 'Linear',
  gmail: 'Gmail',
  outlook: 'Outlook',
  'google-calendar': 'Google Calendar',
  'outlook-calendar': 'Outlook Calendar',
  teams: 'Teams',
  github: 'GitHub',
};

/** What kind of Item a Source's change is on, when the Item itself has gone. */
export const ITEM_KIND_OF_SOURCE: Record<Source, ItemKind> = {
  linear: 'linear-issue',
  gmail: 'email',
  outlook: 'email',
  'google-calendar': 'event',
  'outlook-calendar': 'event',
  teams: 'chat',
  github: 'pull-request',
};

/**
 * One change in words: `what` as Settings lists it ("Move to In Review"), and `verb` and `rest` around
 * the Item's name for a sentence ("moving" ENG-418 "to In Review").
 */
export type ChangeWords = { what: string; verb: string; rest: string };

type Change = { field: string; value: unknown; synced: unknown };
type ItemOf = { kind: ItemKind; source: Source | null };

const PRIORITY_NAMES = ['No priority', 'Urgent', 'High', 'Medium', 'Low'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number) => String(n).padStart(2, '0');

const quoted = (text: string) => `“${text.replace(/\s+/g, ' ').trim()}”`;

// A name out of a value: `{ name: "In Review" }` gives "In Review".
const nameIn = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null || !('name' in value)) return null;
  const { name } = value as { name: unknown };
  return typeof name === 'string' && name.trim() ? name.trim() : null;
};

// "9 Oct", from a calendar day (YYYY-MM-DD), the same in every time zone.
function day(value: string): string {
  const [, month, date] = value.split('-').map(Number);
  return month && date ? `${date} ${MONTHS[month - 1]}` : value;
}

// "Thu 8 Oct, 15:00" in the User's local time, or "Thu 8 Oct" for an all-day event's day.
function when(time: EventTime, allDay: boolean): string {
  if (allDay && time.date) {
    const [year, month, date] = time.date.split('-').map(Number);
    const local = new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1);
    return `${WEEKDAYS[local.getDay()]} ${day(time.date)}`;
  }
  const at = new Date(time.at);
  return `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}, ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

const words = (what: string, verb: string, rest = ''): ChangeWords => ({ what, verb, rest });

function linearWords({ field, value, synced }: Change, source: Source | null): ChangeWords {
  if (field === 'state') {
    const name = nameIn(value);
    return name
      ? words(`Move to ${name}`, 'moving', `to ${name}`)
      : words('Change the state', 'changing the state of');
  }
  if (field === 'assignee') {
    const name = nameIn(value);
    return name ? words(`Assign to ${name}`, 'assigning', `to ${name}`) : words('Unassign', 'unassigning');
  }
  if (field === 'priority') {
    const name = typeof value === 'number' ? PRIORITY_NAMES[value] : undefined;
    if (!name || value === 0) return words('Clear the priority', 'clearing the priority of');
    return words(`Set the priority to ${name}`, 'setting the priority of', `to ${name}`);
  }
  if (field === 'dueDate') {
    if (typeof value !== 'string') return words('Clear the due date', 'clearing the due date of');
    return words(`Set the due date to ${day(value)}`, 'setting the due date of', `to ${day(value)}`);
  }
  if (field === 'estimate') {
    if (typeof value !== 'number') return words('Clear the estimate', 'clearing the estimate of');
    return words(`Set the estimate to ${value}`, 'setting the estimate of', `to ${value}`);
  }
  if (field === 'cycle') {
    if (typeof value !== 'object' || value === null)
      return words('Take out of its cycle', 'taking', 'out of its cycle');
    const { number, name } = value as { number?: unknown; name?: unknown };
    const cycle = typeof name === 'string' && name.trim() ? name.trim() : `Cycle ${number}`;
    return words(`Move to ${cycle}`, 'moving', `to ${cycle}`);
  }
  if (field === 'linearProject') {
    const name = nameIn(value);
    if (!name) return words('Take out of its Linear project', 'taking', 'out of its Linear project');
    return words(`Move to the Linear project ${name}`, 'moving', `to the Linear project ${name}`);
  }
  if (field.startsWith('label:')) return labelWords(value, synced);
  if (field.startsWith('comment:'))
    return value ? words('Comment', 'commenting on') : words('Delete a comment', 'deleting a comment on');
  if (field === CREATE_FIELD) {
    const where = SOURCE_NAME_OF[source ?? 'linear'];
    return words(`Create in ${where}`, 'creating', `in ${where}`);
  }
  return deleteOr({ field, value, synced });
}

function labelWords(value: unknown, synced: unknown): ChangeWords {
  const added = nameIn(value);
  if (added) return words(`Add the label ${quoted(added)}`, 'labelling', quoted(added));
  const removed = nameIn(synced);
  return removed
    ? words(`Remove the label ${quoted(removed)}`, `removing the label ${quoted(removed)} from`)
    : words('Remove a label', 'removing a label from');
}

// A deletion (or taking one back), or a field these words don't know.
function deleteOr({ field, value }: Change): ChangeWords {
  if (field === DELETE_FIELD)
    return value === null ? words('Bring back', 'bringing back') : words('Delete', 'deleting');
  return words(`Change ${field}`, `changing ${field} on`);
}

function emailWords(change: Change): ChangeWords {
  const { field, value, synced } = change;
  switch (field) {
    case 'inbox':
      return value ? words('Move to the inbox', 'moving', 'to the inbox') : words('Archive', 'archiving');
    case 'read':
      return value
        ? words('Mark as read', 'marking', 'as read')
        : words('Mark as unread', 'marking', 'as unread');
    case 'starred':
      return value ? words('Star', 'starring') : words('Unstar', 'unstarring');
    case 'trash':
      return value
        ? words('Move to Trash', 'moving', 'to Trash')
        : words('Take out of Trash', 'taking', 'out of Trash');
    case 'folder': {
      const name = nameIn(value);
      return name
        ? words(`Move to ${name}`, 'moving', `to ${name}`)
        : words('Move to another folder', 'moving', 'to another folder');
    }
    case 'bucket-mirror':
      return words('Show its Bucket at the Source', 'showing the Bucket of', 'at the Source');
    case DRAFT_FIELD:
      return words('Save the draft', 'saving the draft');
    case SEND_FIELD:
      return words('Send', 'sending');
    case CANCEL_SEND_FIELD:
      return words('Take back from the Outbox', 'taking back', 'from the Outbox');
    case DELETE_FIELD:
      return words('Discard the draft', 'discarding the draft');
  }
  if (field.startsWith('label:')) return labelWords(value, synced);
  return deleteOr(change);
}

// How answering an invitation reads in a sentence: "accepting “Pricing review”".
const ANSWERING: Partial<Record<EventResponse, string>> = {
  accepted: 'accepting',
  tentative: 'answering Maybe to',
  declined: 'declining',
};

function eventWords(change: Change, source: Source | null): ChangeWords {
  const { field, value } = change;
  if (field === 'response' || field === 'seriesResponse') {
    const name = ANSWER_NAMES[value as InvitationAnswer] as string | undefined;
    const verb = ANSWERING[value as EventResponse] ?? 'answering';
    return field === 'seriesResponse'
      ? words(`Answer the series: ${name ?? 'an answer'}`, `${verb} every event in the series of`)
      : words(`Answer: ${name ?? 'an answer'}`, verb);
  }
  if (field === 'time') {
    const move = value as { start?: EventTime; allDay?: boolean } | null;
    if (!move?.start) return words('Change the time', 'changing the time of');
    const at = when(move.start, move.allDay === true);
    return words(`Move to ${at}`, 'moving', `to ${at}`);
  }
  if (field === CREATE_FIELD) {
    const where = source ? SOURCE_NAME_OF[source] : 'the calendar';
    return words(`Create in ${where}`, 'creating', `in ${where}`);
  }
  return deleteOr(change);
}

/** A queued change in words, from the change's data and the kind of Item it is on. */
export function changeWords(change: Change, item: ItemOf): ChangeWords {
  const { field, value } = change;
  switch (item.kind) {
    case 'linear-issue':
      return linearWords(change, item.source);
    case 'email':
      return emailWords(change);
    case 'event':
      return eventWords(change, item.source);
    case 'chat':
      if (field === 'read')
        return value
          ? words('Mark as read', 'marking', 'as read')
          : words('Mark as unread', 'marking', 'as unread');
      if (field.startsWith('message:'))
        return value ? words('Reply', 'replying in') : words('Cancel a reply', 'cancelling a reply in');
      return deleteOr(change);
    case 'channel-post':
      if (field.startsWith('reply:'))
        return value ? words('Reply', 'replying to') : words('Cancel a reply', 'cancelling a reply to');
      return deleteOr(change);
    default:
      return deleteOr(change);
  }
}

/** The change said with the Item's name: "moving ENG-418 to In Review". */
export const changePhrase = ({ verb, rest }: ChangeWords, name: string) =>
  `${verb} ${name}${rest ? ` ${rest}` : ''}`;

/** The activity log's word for a Discard (#206): "Discarded “Move to In Review”: it didn’t reach Linear". */
export const discardedWhy = (what: string, source: Source) =>
  `Discarded ${quoted(what)}: it didn’t reach ${SOURCE_NAME_OF[source]}`;

/** Whether an activity entry's word says it was a Discard. */
export const isDiscardedWhy = (why: string | null | undefined) =>
  !!why && why.startsWith('Discarded “') && why.includes('”: it didn’t reach ');
