import type { OutgoingChange, ThreadAction } from '@commander/domain';
import { type IssueSync, issueSync } from '../linear/editing';

/*
  Organising mail in the Email Section (#135), as pure functions: what each action's toast says, how
  snooze times read, whether a thread's changes reached Gmail, and the "mark read when opened"
  setting (Settings → Email), kept on this machine like the Account switcher.
*/

export const MARK_READ_STORAGE_KEY = 'commander.email.markRead';

// Opening a thread marks it read: at once (Gmail's default), after 2 seconds, or never.
export const MARK_READ_CHOICES = [
  { value: '0', label: 'At once', delayMs: 0 },
  { value: '2', label: 'After 2 seconds', delayMs: 2_000 },
  { value: 'never', label: 'Never', delayMs: null },
] as const;
export type MarkRead = (typeof MARK_READ_CHOICES)[number]['value'];

export function loadMarkRead(storage: Storage): MarkRead {
  try {
    const saved = storage.getItem(MARK_READ_STORAGE_KEY);
    return MARK_READ_CHOICES.find((choice) => choice.value === saved)?.value ?? '0';
  } catch {
    return '0';
  }
}

export function saveMarkRead(storage: Storage, value: MarkRead) {
  try {
    storage.setItem(MARK_READ_STORAGE_KEY, value);
  } catch {
    // Not remembered, then.
  }
}

/** How long after opening a thread it is marked read, or null for never. */
export function markReadDelay(value: MarkRead): number | null {
  const choice = MARK_READ_CHOICES.find((each) => each.value === value);
  return choice ? choice.delayMs : 0;
}

export const SNOOZE_NOTE =
  'Snoozed mail comes back only while Commander is running (the window or the tray).';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** A snooze time: "14:59" today, "Thu 08:00" within the coming week, else "19 Oct 08:00". */
export function snoozeTime(at: number, now: number): string {
  const date = new Date(at);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return clock;
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at >= startOfToday && at < startOfToday + 7 * 86_400_000) return `${DAYS[date.getDay()]} ${clock}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${clock}`;
}

/** What a toast says once an action is done to the thread called `subject`. */
export function actionToast(action: ThreadAction, subject: string, now: number): string {
  const said = subject || '(no subject)';
  switch (action.type) {
    case 'archive':
      return `Archived: ${said}`;
    case 'move-to-inbox':
      return `Moved to the inbox: ${said}`;
    case 'trash':
      return `Moved to Trash: ${said}`;
    case 'read':
      return `Marked read: ${said}`;
    case 'unread':
      return `Marked unread: ${said}`;
    case 'star':
      return `Starred: ${said}`;
    case 'unstar':
      return `Unstarred: ${said}`;
    case 'label':
      return `Labelled ${action.label.name}: ${said}`;
    case 'unlabel':
      return `Label removed: ${said}`;
    case 'snooze':
      return `Snoozed until ${snoozeTime(action.until, now)}: ${said}`;
    case 'unsnooze':
      return `Unsnoozed: ${said}`;
  }
}

/** Where a thread's own changes stand: all in Gmail, on their way, or (any of them) Couldn't sync. */
export const threadSync = (changes: readonly OutgoingChange[]): IssueSync => issueSync(changes);
