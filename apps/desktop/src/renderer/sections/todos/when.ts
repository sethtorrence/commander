const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The time of day, in local time: "09:05". */
export function timeOfDay(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** When something happened, in local time: "09:05" today, "30 Sep" this year, "31 Dec 2025" before. */
export function whenShort(at: number, now = Date.now()): string {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return timeOfDay(at);
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === today.getFullYear() ? day : `${day} ${date.getFullYear()}`;
}
