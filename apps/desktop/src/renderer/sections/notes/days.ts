import { partNumber } from '../../frame/calendar';

// Calendar days as the Notes Section names them: keyed YYYY-MM-DD in local time, as Daily Notes are.

const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
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

export const dayKey = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** Local midnight on a day. */
export function dateOf(day: string): Date {
  const [year = 1970, month = 1, date = 1] = day.split('-').map(Number);
  return new Date(year, month - 1, date);
}

export function addDays(day: string, days: number): string {
  const date = dateOf(day);
  date.setDate(date.getDate() + days);
  return dayKey(date);
}

/** "Thursday" */
export const weekday = (day: string) => WEEKDAYS[dateOf(day).getDay()] ?? '';

/** "1 October 2026" */
export function longDate(day: string): string {
  const date = dateOf(day);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** "DN-2026-274": the Daily Note's part number, from its day of the year. */
export const notePartNumber = (day: string) => partNumber('DN', dateOf(day));

/** The sheet's eyebrow: "Today", "Yesterday", "2 days ago". */
export function dayLabel(day: string, today: string): string {
  const days = Math.round((dateOf(today).getTime() - dateOf(day).getTime()) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

/** The seven days, Monday to Sunday, of the week holding `day`. */
export function weekOf(day: string): string[] {
  const monday = addDays(day, -((dateOf(day).getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

const shortDay = (day: string) => {
  const date = dateOf(day);
  return `${pad(date.getDate())} ${MONTHS[date.getMonth()]?.slice(0, 3)}`;
};

/** "28 Sep — 04 Oct" */
export function weekRange(day: string): string {
  const week = weekOf(day);
  return `${shortDay(week[0] ?? day)} — ${shortDay(week[6] ?? day)}`;
}
