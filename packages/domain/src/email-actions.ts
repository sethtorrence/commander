import { BUCKET_FIELD } from './buckets';
import type { EmailDetail, EmailLabel } from './email';
import { EMAIL_VIEWS, type EmailFixedView, type EmailListView } from './email-threads';
import { isEmailLabelField, LABEL_FIELD, SNOOZE_FIELD } from './synced-fields';

/*
  Organising email (#135), as pure functions the Item store and the window share:

  - **Thread actions:** what archiving, Trash, starring, read and unread, labels, snooze and moving to a
    Bucket (#137) change on each message of a thread (emails are Items, one per message), as
    `edit-fields` changes of their synced fields. Only messages that change are named, so every entry is a real change to undo.
  - **Views:** which of the Email Section's views a thread is in (Inbox, Starred, Snoozed, Archive,
    Trash, and each label), from its messages.
  - **Section search:** the operators `/` understands (from:, to:, subject:, has:attachment,
    is:unread, in:<view or label>), and the link to Gmail's own search for mail older than what
    Commander downloaded.
  - **Snooze choices:** Later today, Tomorrow morning, This weekend and Next week, in local time.
*/

export type ThreadAction =
  | { type: 'archive' }
  | { type: 'move-to-inbox' }
  | { type: 'trash' }
  | { type: 'read' }
  | { type: 'unread' }
  | { type: 'star' }
  | { type: 'unstar' }
  | { type: 'label'; label: EmailLabel }
  | { type: 'unlabel'; labelId: string }
  | { type: 'snooze'; until: number }
  | { type: 'unsnooze' }
  // Moves the thread to a Bucket (null: Unsorted), by the User (#137).
  | { type: 'bucket'; bucketId: string | null };

export type ThreadMessage = { id: string; detail: EmailDetail };
export type MessageFields = { itemId: string; fields: Record<string, unknown> };

const hasLabel = (detail: EmailDetail, labelId: string) =>
  detail.labels.some((label) => label.id === labelId);

/** What a thread action changes on each of the thread's messages (oldest first), leaving out none-changes. */
export function threadActionFields(
  action: ThreadAction,
  messages: readonly ThreadMessage[],
): MessageFields[] {
  const ordered = [...messages].sort((a, b) => a.detail.sentAt - b.detail.sentAt || a.id.localeCompare(b.id));
  const each = (fieldsOf: (detail: EmailDetail) => Record<string, unknown> | null): MessageFields[] =>
    ordered.flatMap(({ id, detail }) => {
      const fields = fieldsOf(detail);
      return fields && Object.keys(fields).length ? [{ itemId: id, fields }] : [];
    });
  switch (action.type) {
    case 'archive':
      return each((detail) => ({
        ...(detail.inInbox ? { inbox: false } : {}),
        // A snoozed thread that came back loses its "Snoozed until" once dealt with.
        ...(detail.snooze ? { [SNOOZE_FIELD]: null } : {}),
      }));
    case 'move-to-inbox':
      return each((detail) => ({
        ...(detail.inTrash ? { trash: false } : {}),
        ...(detail.inInbox ? {} : { inbox: true }),
      }));
    case 'trash':
      // A snoozed thread moved to Trash is unsnoozed, so it never comes back from there.
      return each((detail) => ({
        ...(detail.inTrash ? {} : { trash: true }),
        ...(detail.snooze ? { [SNOOZE_FIELD]: null } : {}),
      }));
    case 'read':
      return each((detail) => (detail.read ? null : { read: true }));
    case 'unread':
      return each((detail) => (detail.read ? { read: false } : null));
    case 'star': {
      // Gmail stars a conversation's latest message.
      const latest = ordered.at(-1);
      return latest && !latest.detail.starred ? [{ itemId: latest.id, fields: { starred: true } }] : [];
    }
    case 'unstar':
      return each((detail) => (detail.starred ? { starred: false } : null));
    case 'label':
      return each((detail) =>
        hasLabel(detail, action.label.id)
          ? null
          : { [`${LABEL_FIELD}${action.label.id}`]: { id: action.label.id, name: action.label.name } },
      );
    case 'unlabel':
      return each((detail) =>
        hasLabel(detail, action.labelId) ? { [`${LABEL_FIELD}${action.labelId}`]: null } : null,
      );
    case 'snooze':
      return each((detail) =>
        detail.snooze?.until === action.until && !detail.snooze.returned
          ? null
          : { [SNOOZE_FIELD]: { until: action.until, returned: false } },
      );
    case 'unsnooze':
      return each((detail) => (detail.snooze ? { [SNOOZE_FIELD]: null } : null));
    case 'bucket':
      // Already there by the User's hand: nothing to change. Sorted there by a Rule or Ares, it is
      // the User's now, so neither moves it again.
      return each((detail) =>
        detail.bucket?.sortedBy === 'user' && (detail.bucket.bucketId ?? null) === action.bucketId
          ? null
          : { [BUCKET_FIELD]: { bucketId: action.bucketId, sortedBy: 'user' } },
      );
  }
}

// ---------------------------------------------------------------------------------------------
// Views

/** A snooze still waiting at `now`: its time, or null. */
export const activeSnooze = (detail: EmailDetail, now: number): number | null =>
  detail.snooze && !detail.snooze.returned && detail.snooze.until > now ? detail.snooze.until : null;

/**
 * When a thread is snoozed until (every message snoozed and waiting: mail arriving since brings the
 * thread back, as in Gmail), or null.
 */
export function threadSnoozedUntil(details: readonly EmailDetail[], now: number): number | null {
  const times = details.map((detail) => activeSnooze(detail, now));
  if (!times.length || times.some((time) => time === null)) return null;
  return Math.min(...(times as number[]));
}

/** What decides which views a thread is in, from its messages (or the Core's aggregates of them). */
export type ThreadFlags = {
  // Some message out of Trash is in the inbox, or starred.
  inInbox: boolean;
  starred: boolean;
  // Some message is in Trash; some isn't.
  trashed: boolean;
  live: boolean;
  // Snoozed until then (threadSnoozedUntil), or null.
  snoozedUntil: number | null;
  // The labels on its messages out of Trash.
  labels: ReadonlySet<string>;
};

export function threadFlagsOf(details: readonly EmailDetail[], now: number): ThreadFlags {
  const live = details.filter((detail) => !detail.inTrash);
  return {
    inInbox: live.some((detail) => detail.inInbox),
    starred: live.some((detail) => detail.starred),
    trashed: live.length < details.length,
    live: live.length > 0,
    snoozedUntil: threadSnoozedUntil(details, now),
    labels: new Set(live.flatMap((detail) => detail.labels.map((label) => label.id))),
  };
}

/** Whether a thread is in a view: trashed threads only in Trash, snoozed ones only in Snoozed. */
export function flagsInView(flags: ThreadFlags, view: EmailListView): boolean {
  if (view === 'trash') return flags.trashed;
  if (!flags.live) return false;
  const snoozed = flags.snoozedUntil !== null;
  if (view === 'snoozed') return snoozed;
  if (snoozed) return false;
  switch (view) {
    case 'inbox':
      return flags.inInbox;
    case 'archive':
      return !flags.inInbox;
    case 'starred':
      return flags.starred;
    default:
      return flags.labels.has(view.slice(LABEL_FIELD.length));
  }
}

/** Whether a thread (its messages) is in a view. */
export const threadInView = (details: readonly EmailDetail[], view: EmailListView, now: number) =>
  flagsInView(threadFlagsOf(details, now), view);

// ---------------------------------------------------------------------------------------------
// Section search

export type EmailSearch = {
  // The words left once the operators are taken out, for the word index.
  words: string;
  from: string[];
  to: string[];
  subject: string[];
  hasAttachment: boolean;
  unread: boolean;
  // `in:` a view; or `in:` anything else, a label by name.
  view: EmailFixedView | null;
  label: string | null;
};

const OPERATOR = /(?:^|\s)(from|to|subject|has|is|in):(?:"([^"]*)"|(\S+))/gi;

/** The operators in what was typed into the Email Section's search, and the words left over. */
export function parseEmailSearch(text: string): EmailSearch {
  const search: EmailSearch = {
    words: '',
    from: [],
    to: [],
    subject: [],
    hasAttachment: false,
    unread: false,
    view: null,
    label: null,
  };
  const words = text.replace(OPERATOR, (whole, name: string, quoted?: string, bare?: string) => {
    const value = (quoted ?? bare ?? '').trim();
    const operator = name.toLowerCase();
    const lower = value.toLowerCase();
    if (!value) return ' ';
    if (operator === 'from' || operator === 'to' || operator === 'subject') search[operator].push(lower);
    else if (operator === 'has' && (lower === 'attachment' || lower === 'attachments'))
      search.hasAttachment = true;
    else if (operator === 'is' && lower === 'unread') search.unread = true;
    else if (operator === 'in') {
      if ((EMAIL_VIEWS as readonly string[]).includes(lower)) search.view = lower as EmailFixedView;
      else search.label = lower;
    } else return whole;
    return ' ';
  });
  search.words = words.replace(/\s+/g, ' ').trim();
  return search;
}

const addressText = (address: { name: string | null; address: string } | null) =>
  address ? `${address.name ?? ''} ${address.address}`.toLowerCase() : '';

/** Whether a message matches the search's message operators (from:, to:, subject:, has:, is:). */
export function emailSearchMatches(detail: EmailDetail, search: EmailSearch): boolean {
  const from = addressText(detail.from);
  const to = [...detail.to, ...detail.cc, ...detail.bcc].map(addressText).join(' ');
  const subject = detail.subject.toLowerCase();
  return (
    search.from.every((each) => from.includes(each)) &&
    search.to.every((each) => to.includes(each)) &&
    search.subject.every((each) => subject.includes(each)) &&
    (!search.hasAttachment || detail.attachments.some((attachment) => !attachment.inline)) &&
    (!search.unread || !detail.read)
  );
}

// How Commander's in:<view> reads in Gmail's search (Commander's snooze isn't Gmail's).
const GMAIL_VIEWS: Record<EmailFixedView, string | null> = {
  inbox: 'in:inbox',
  starred: 'is:starred',
  snoozed: null,
  archive: '-in:inbox',
  trash: 'in:trash',
};

/** Gmail's own search for what was typed, in the Account, for mail older than Commander downloaded. */
export function gmailSearchUrl(accountEmail: string, text: string): string {
  const query = text
    .replace(/(^|\s)in:(?:"([^"]*)"|(\S+))/gi, (_whole, space: string, quoted?: string, bare?: string) => {
      const value = (quoted ?? bare ?? '').trim();
      const lower = value.toLowerCase();
      if ((EMAIL_VIEWS as readonly string[]).includes(lower)) {
        const said = GMAIL_VIEWS[lower as EmailFixedView];
        return said ? `${space}${said}` : space;
      }
      return `${space}label:${/\s/.test(value) ? `"${value}"` : value}`;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(accountEmail)}#search/${encodeURIComponent(query)}`;
}

// ---------------------------------------------------------------------------------------------
// Snooze choices

export type EmailSnoozeChoice = { label: string; until: number };

const at = (date: Date, days: number, hour: number) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, hour).getTime();

/**
 * The quick snooze times, as Gmail offers them, in local time: Later today (18:00, until 17:00),
 * Tomorrow morning (08:00), This weekend (Saturday 08:00, on weekdays) and Next week (Monday 08:00).
 */
export function emailSnoozeChoices(now: number): EmailSnoozeChoice[] {
  const date = new Date(now);
  const weekday = date.getDay();
  const choices: EmailSnoozeChoice[] = [];
  if (date.getHours() < 17) choices.push({ label: 'Later today', until: at(date, 0, 18) });
  choices.push({ label: 'Tomorrow morning', until: at(date, 1, 8) });
  if (weekday >= 1 && weekday <= 5) choices.push({ label: 'This weekend', until: at(date, 6 - weekday, 8) });
  choices.push({ label: 'Next week', until: at(date, (8 - weekday) % 7 || 7, 8) });
  return choices;
}

/** Whether a label is one the User picks (`l`): theirs and Gmail's categories, not a flag like INBOX. */
export const isPickableLabel = (labelId: string) =>
  isEmailLabelField(labelId) && !labelId.startsWith('CATEGORY_') && labelId !== 'IMPORTANT';
