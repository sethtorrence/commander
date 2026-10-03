// Dates as the drawing shows them: the header's date block and clock, and sheet part numbers
// (e.g. DSH-2026-274: the sheet's code, the year, the day of the year). All in local time.

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const DAY_MS = 86_400_000;

// Whole days between two local dates, immune to daylight-saving shifts.
const daysBetween = (from: Date, to: Date) =>
  Math.round(
    (Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) -
      Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) /
      DAY_MS,
  );

export function dayOfYear(date: Date): number {
  return daysBetween(new Date(date.getFullYear(), 0, 1), date) + 1;
}

/** The ISO 8601 week: weeks start on Monday, and week 1 holds the year's first Thursday. */
export function isoWeek(date: Date): number {
  const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  thursday.setDate(thursday.getDate() + 3 - ((thursday.getDay() + 6) % 7));
  return Math.floor((dayOfYear(thursday) - 1) / 7) + 1;
}

export function partNumber(code: string, date: Date): string {
  return `${code}-${date.getFullYear()}-${pad(dayOfYear(date), 3)}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Thu 01 Oct" */
export function shortDate(date: Date): string {
  return `${WEEKDAYS[date.getDay()]} ${pad(date.getDate())} ${MONTHS[date.getMonth()]}`;
}

/** "09:05:07" */
export function clockTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
