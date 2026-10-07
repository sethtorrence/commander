import { z } from 'zod';
import { LINK_REF } from './conversations';
import type { SkillInfo } from './skills';

/*
  Ares's action Skills (#196, decision #24): what the User can tell him to do from a Conversation.
  Manage Todos, File, Snooze and Linear actions each hand the gate proposals, under the User's Autonomy
  settings for the Action kind and Section, as every Ares action does (ADR 0004): what the settings let
  run goes ahead, reported in his answer with Undo; what must ask is prepared in the Conversation as a
  card the User confirms with one key. Each is a registered action of its own, so it has its own line
  in Settings → Autonomy.

  What the model gives them names Items only by the refs handed to him for this answer (I1, I2…), and
  times only in words Commander turns into dates on the User's own calendar ("friday", "next-week"),
  or as dates. This file holds what they need (checked before they run) and those words.
*/

// An Item he was handed for this answer, by its ref.
const ref = z.string().trim().regex(LINK_REF, 'name an Item by the ref you were given, as "I1"');
const refs = (most: number) => z.array(ref).min(1).max(most);

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})[t ](\d{2}):(\d{2})$/i;

// The words a due day may be given in, beside a date (YYYY-MM-DD).
export const DUE_WORDS: readonly string[] = [
  'today',
  'tomorrow',
  'this-weekend',
  'next-week',
  ...WEEKDAYS.slice(1),
  'sunday',
];
// The words a snooze time may be given in, beside a date (YYYY-MM-DD, at 08:00) or a time on one.
export const SNOOZE_WORDS: readonly string[] = [
  'later-today',
  'tomorrow',
  'this-weekend',
  'next-week',
  ...WEEKDAYS.slice(1),
  'sunday',
];

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const onDay = (now: number, days: number, hour = 0, minute = 0) => {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, hour, minute);
};

function realDay(text: string): boolean {
  if (!ISO_DAY.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

// Days from `now` to the weekday named: the next one, today counting when `today` is allowed.
function daysTo(weekday: number, now: number, today: boolean): number {
  const ahead = (weekday - new Date(now).getDay() + 7) % 7;
  return ahead === 0 && !today ? 7 : ahead;
}

/**
 * The day a due word means on the User's local calendar, as YYYY-MM-DD: "today", "tomorrow", a
 * weekday (the next one, today counting: "by Friday" on a Friday is today), "this-weekend" (the coming
 * Saturday, or today on a Sunday), "next-week" (Monday of next week), or a date as it is. Null when
 * it is none of those.
 */
export function dueDayFrom(word: string, now: number): string | null {
  const text = word.trim().toLowerCase();
  if (realDay(text)) return text;
  const weekday = WEEKDAYS.indexOf(text as (typeof WEEKDAYS)[number]);
  if (weekday !== -1) return dayOf(onDay(now, daysTo(weekday, now, true)));
  const today = new Date(now).getDay();
  switch (text) {
    case 'today':
      return dayOf(onDay(now, 0));
    case 'tomorrow':
      return dayOf(onDay(now, 1));
    case 'this-weekend':
      return dayOf(onDay(now, today === 0 ? 0 : 6 - today));
    case 'next-week':
      return dayOf(onDay(now, daysTo(1, now, false)));
    default:
      return null;
  }
}

/**
 * When a snooze word means, on the User's local clock, as Commander's own Snooze offers them:
 * "later-today" (18:00), "tomorrow" (08:00), "this-weekend" (Saturday 08:00), "next-week" (Monday
 * 08:00), a weekday (the next one after today, 08:00), a date (08:00 that day) or a date and time
 * ("2026-10-12T14:30"). Null when it is none of those, or not after `now`.
 */
export function snoozeUntilFrom(word: string, now: number): number | null {
  const text = word.trim().toLowerCase();
  let at: Date | null = null;
  const time = ISO_TIME.exec(text);
  const weekday = WEEKDAYS.indexOf(text as (typeof WEEKDAYS)[number]);
  if (time) {
    const [, year, month, day, hour, minute] = time.map(Number) as number[];
    if (realDay(text.slice(0, 10)) && (hour as number) < 24 && (minute as number) < 60)
      at = new Date(year as number, (month as number) - 1, day, hour, minute);
  } else if (realDay(text)) {
    const [year, month, day] = text.split('-').map(Number) as [number, number, number];
    at = new Date(year, month - 1, day, 8);
  } else if (weekday !== -1) {
    at = onDay(now, daysTo(weekday, now, false), 8);
  } else if (text === 'later-today') {
    at = onDay(now, 0, 18);
  } else if (text === 'tomorrow') {
    at = onDay(now, 1, 8);
  } else if (text === 'this-weekend') {
    at = onDay(now, daysTo(6, now, false), 8);
  } else if (text === 'next-week') {
    at = onDay(now, daysTo(1, now, false), 8);
  }
  const until = at?.getTime() ?? null;
  return until !== null && until > now ? until : null;
}

const dueWord = z
  .string()
  .trim()
  .toLowerCase()
  .refine((word) => DUE_WORDS.includes(word) || realDay(word), {
    message: `one of ${DUE_WORDS.map((word) => `"${word}"`).join(', ')} or a date as YYYY-MM-DD`,
  });

const snoozeWord = z
  .string()
  .trim()
  .toLowerCase()
  .refine((word) => SNOOZE_WORDS.includes(word) || realDay(word) || ISO_TIME.test(word), {
    message: `one of ${SNOOZE_WORDS.map((word) => `"${word}"`).join(', ')}, a date as YYYY-MM-DD or a time as YYYY-MM-DDTHH:MM`,
  });

const dueNeeds = `${DUE_WORDS.map((word) => `"${word}"`).join(', ')} or a date as "YYYY-MM-DD"`;

// ---------------------------------------------------------------------------------------------
// Manage Todos

// The registered action: Organise, in the Todos Section.
export const CONVERSATION_TODOS = 'conversation-todos';

export const manageTodosInput = z.discriminatedUnion('action', [
  // A new Todo, from what the User said; `from`: an Item he was handed that it is made from.
  z.object({
    action: z.literal('add'),
    title: z.string().trim().min(1).max(200),
    due: dueWord.optional(),
    project: z.string().trim().min(1).max(120).optional(),
    from: ref.optional(),
  }),
  z.object({ action: z.literal('done'), todos: refs(20) }),
  z.object({ action: z.literal('reopen'), todos: refs(20) }),
  // A new due day; null takes it away.
  z.object({ action: z.literal('due'), todos: refs(20), due: dueWord.nullable() }),
]);
export type ManageTodosInput = z.infer<typeof manageTodosInput>;

export const MANAGE_TODOS_NEEDS = `one of {"action":"add","title": the Todo in a few words, "due": when it is due (optional), "project": a Project’s name or code (optional), "from": the ref of an Item it is made from (optional)}, {"action":"done","todos":[refs]}, {"action":"reopen","todos":[refs]} or {"action":"due","todos":[refs],"due": the new due day, or null for none}, where a due day is ${dueNeeds}`;

export const MANAGE_TODOS_SKILL: SkillInfo = {
  name: 'todos',
  title: 'Manage Todos',
  description:
    'Add a Todo for the User, tick Todos done (or open again), or move when Todos are due ("add a Todo to send Leo the redlines by Friday", "mark the invoice Todo done", "move my Acme Todos to next week"). To change Todos that already exist, find them first and give their refs.',
  summary: 'Adds Todos, ticks them done and moves when they’re due, as your Autonomy settings allow.',
  example: 'Add a Todo to send Leo the redlines by Friday',
  acts: true,
};

// ---------------------------------------------------------------------------------------------
// File

// The registered action: Organise, in each Item's own Section.
export const CONVERSATION_FILE = 'conversation-file';

export const fileInput = z.object({
  items: refs(20),
  project: z.string().trim().min(1).max(120),
});
export type FileInput = z.infer<typeof fileInput>;

export const FILE_NEEDS = '{"items":[the refs of the Items to file], "project": the Project’s name or code}';

export const FILE_SKILL: SkillInfo = {
  name: 'file',
  title: 'File',
  description:
    'File Items into one of the User’s Projects ("file this under Longtail", "put the Relay PRs in Titanlink"). Find the Items first and give their refs. Items the User or a Rule filed stay where they are.',
  summary: 'Files Items into a Project; what you or a Rule filed stays yours.',
  example: 'Put the Relay PRs in Titanlink',
  acts: true,
};

// ---------------------------------------------------------------------------------------------
// Snooze

// The registered action: Organise, in the Email Section (Commander's own Snooze never reaches Gmail
// or Outlook).
export const CONVERSATION_SNOOZE = 'conversation-snooze';

export const snoozeInput = z.object({ items: refs(10), until: snoozeWord });
export type SnoozeInput = z.infer<typeof snoozeInput>;

export const SNOOZE_NEEDS = `{"items":[the refs of the emails whose threads to snooze], "until": ${SNOOZE_WORDS.map((word) => `"${word}"`).join(', ')}, a date as "YYYY-MM-DD" (08:00 that day) or a time as "YYYY-MM-DDTHH:MM"}`;

export const SNOOZE_SKILL: SkillInfo = {
  name: 'snooze',
  title: 'Snooze',
  description:
    'Snooze email threads until a time, with Commander’s own Snooze: the thread leaves the inbox and comes back to the top of it then ("snooze this until Monday"). Find the emails first and give their refs.',
  summary: 'Snoozes an email thread until the time you say, with Commander’s own Snooze.',
  example: 'Snooze the Acme thread until Monday',
  acts: true,
};

// ---------------------------------------------------------------------------------------------
// Linear actions

// The registered action: Act for you, in the Linear Section (what changes in Linear is seen by other
// people), so it only ever asks.
export const CONVERSATION_LINEAR = 'conversation-linear';

export const linearActionsInput = z.discriminatedUnion('action', [
  // Moves issues to a workflow state of their team, by its name.
  z.object({ action: z.literal('state'), issues: refs(10), state: z.string().trim().min(1).max(80) }),
  // Assigns issues: "me", a member's name, or null for nobody.
  z.object({
    action: z.literal('assign'),
    issues: refs(10),
    to: z.string().trim().min(1).max(120).nullable(),
  }),
  // Sends a Todo (or a Daily Note line) to Linear as a new issue.
  z.object({
    action: z.literal('send'),
    todo: ref,
    team: z.string().trim().min(1).max(80).optional(),
  }),
]);
export type LinearActionsInput = z.infer<typeof linearActionsInput>;

export const LINEAR_NEEDS =
  'one of {"action":"state","issues":[refs],"state": the workflow state’s name}, {"action":"assign","issues":[refs],"to": "me", a person’s name, or null for nobody} or {"action":"send","todo": the ref of a Todo or Daily Note line,"team": the Linear team’s key or name (optional)}, where an issue is a Linear issue or a Linear Todo';

export const LINEAR_SKILL: SkillInfo = {
  name: 'linear',
  title: 'Linear actions',
  description:
    'Change Linear issues for the User or send a Todo to Linear: move issues to a workflow state ("move LT-142 to In Review"), assign them ("assign it to me"), or make a Todo a new Linear issue ("send this Todo to Linear"). What changes in Linear is seen by other people, so it always waits for the User to confirm. Find the issue or Todo first and give its ref.',
  summary: 'Moves Linear issues, assigns them and sends Todos to Linear, each confirmed by you first.',
  example: 'Move LT-142 to In Review',
  acts: true,
};

// The action Skills in the order Ares is told of them.
export const ACTION_SKILLS: readonly SkillInfo[] = [
  MANAGE_TODOS_SKILL,
  FILE_SKILL,
  SNOOZE_SKILL,
  LINEAR_SKILL,
];
