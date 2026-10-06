// Ares's "Block time for Todos" job (#131, decision #17's third scheduler job): he looks at the User's
// open Todos and free time across every calendar and suggests focus blocks ("ENG-412 needs about 2
// hours; you're free Thursday 9–11"). A Deep job at high thinking (decision #19, job 6): one call, no
// tools, a reply that must fit OUTPUT.
//
// - Free time is worked out in code (the domain's focus-time.ts) over the next 5 working days, from
//   every synced event the User is busy in, inside the working hours of Settings → Calendar, in the
//   machine's time zone. Ares only chooses among the free slots, and every block he names is checked
//   again in code: one outside a free slot, overlapping another, or for a Todo he wasn't given is
//   dropped.
// - Input, through the prompt builder: the open Todos (each in its own data block, with its due date,
//   Project, where it came from and, for a Linear Todo, its issue's priority and estimate), the focus
//   blocks already planned, and the free slots. Todos with a focus block to come, or a suggestion
//   waiting, aren't offered again; a waiting suggestion's time counts as taken.
// - Each block becomes a proposal on its Todo, Tidy your Sources / "Block time for Todos" (default
//   Ask): make the event "Focus: <Todo title>", busy and private, in the Commander calendar of the
//   Account chosen in Settings → Calendar (or the only calendar Account), with a made-from Link to the
//   Todo. A suggestion the User dismissed isn't offered again for the same Todo and day.
// - Runs at the first idle moment of each working day, and on request (Plan focus time).
import {
  type CalendarSummary,
  checkFocusBlocks,
  dayInZone,
  type FreeTimeEvent,
  freeSlots,
  type Item,
  inheritedFiling,
  isWorkingDay,
  nextWorkingDays,
  type ProposalRecord,
  type TimeSlot,
  type TodoOrigin,
  timeInZone,
  zonedTime,
} from '@commander/domain';
import { z } from 'zod';
import type { ItemStore } from '../item-store';
import type { AgentJob, JobInput, JobProposal } from './runner';

export const BLOCK_TIME_FOR_TODOS = 'block-time-for-todos';

// How far ahead Ares plans, in working days.
export const WORKING_DAYS_AHEAD = 5;
// The shortest free slot worth offering, and the shortest block kept.
const MIN_SLOT_MINUTES = 30;
const MIN_BLOCK_MINUTES = 15;
// At most this many Todos per call, the most pressing first.
const MAX_TODOS = 40;
const MAX_TITLE = 200;
// Focus blocks this far ahead count as planned.
const PLANNED_AHEAD_MS = 90 * 24 * 60 * 60_000;

const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'YYYY-MM-DDTHH:MM');

export const OUTPUT = z.object({
  blocks: z
    .array(
      z.object({
        // The reference the prompt gave the Todo (T1, T2…), never its id.
        todoId: z.string().min(1).max(20),
        start: localTime,
        end: localTime,
        reason: z.string().trim().min(1).max(300),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(50),
});
type Output = z.infer<typeof OUTPUT>;

type Offered = { ref: string; todo: Item; lines: string[] };
type Input = JobInput & {
  account: string;
  timeZone: string;
  offered: Offered[];
  free: TimeSlot[];
  planned: TimeSlot[];
  days: string[];
  // `${todoId}@${day}` for each suggestion the User dismissed.
  dismissed: Set<string>;
};

const INSTRUCTIONS = `You are Ares. You find time in the User's calendar for the work on their Todo list.

The data lists the User's free time over the next working days (worked out from all their calendars, in their own time zone), the focus blocks already planned, and their open Todos, each marked with a reference ([T1], [T2]…), with its due date, Project, and where it came from (for a Linear issue, its priority and estimate).

Suggest focus blocks: a time to work on one Todo, inside the free time.
- Each block must sit wholly inside one free slot, and blocks must not overlap each other.
- Put the most pressing work first: what is due soonest, then the highest priority.
- Size each block to the work: about 30 minutes for something small, 1–2 hours for a typical task, up to 3 hours for something big. A Linear estimate in points is a guide: 1 point is about an hour.
- At most one block per Todo, unless it plainly needs more than 3 hours and is due soon.
- Leave out Todos that don't need focused time (a quick call, an errand, a reminder), and leave free time free: don't fill every slot.
- Never schedule a Todo after its due date.

Reply with only this JSON object: {"blocks":[{"todoId":"T1","start":"2026-10-08T09:00","end":"2026-10-08T11:00","reason":"…","confidence":0.8}]}
- todoId: the Todo's reference, exactly as marked.
- start, end: local times in the User's time zone, as YYYY-MM-DDTHH:MM, on quarter hours.
- reason: one short sentence for the User, naming what needs the time and when they're free, like "ENG-412 needs about 2 hours; you're free Thursday 9–11."
- confidence: how sure you are this block is worth suggesting, from 0 to 1.
An empty list is fine.`;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PRIORITIES = ['No priority', 'Urgent', 'High', 'Medium', 'Low'];
// Where a Todo came from, as its facts say it; any other was added by the User.
const FROM: Partial<Record<TodoOrigin, string>> = {
  ares: 'suggested by Ares',
  'daily-note': 'a Daily Note',
  email: 'made from an email',
};

// "Thu 8 Oct", for a day.
function dayLabel(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${date} ${MONTHS[month - 1]}`;
}

const span = (slot: TimeSlot, timeZone: string) =>
  `${timeInZone(slot.start, timeZone)}–${timeInZone(slot.end, timeZone)}`;

function cleanTitle(title: string): string {
  const one = title.replace(/\s+/g, ' ').trim();
  return one.length > MAX_TITLE ? `${one.slice(0, MAX_TITLE - 1).trimEnd()}…` : one;
}

/**
 * The Account focus blocks go in: the one chosen in Settings → Calendar while it still has calendars,
 * else the only calendar Account; null while that is unclear.
 */
export function focusAccountOf(chosen: string | null, calendars: readonly CalendarSummary[]): string | null {
  const accounts = [...new Set(calendars.map((calendar) => calendar.account))];
  if (chosen && accounts.includes(chosen)) return chosen;
  return accounts.length === 1 ? (accounts[0] as string) : null;
}

export function blockTimeForTodosJob(
  itemStore: ItemStore,
  { now = Date.now, timeZone = machineZone }: { now?: () => number; timeZone?: () => string } = {},
): AgentJob<Input, Output> {
  const proposalsOf = (statuses: ProposalRecord['status'][]) =>
    itemStore.autonomy.proposals({ action: BLOCK_TIME_FOR_TODOS, statuses, limit: 1000 });

  // A focus block suggestion's time.
  function slotOf(record: ProposalRecord): TimeSlot | null {
    const step = record.itemActions.find((each) => each.type === 'create-event');
    return step?.type === 'create-event' ? { start: step.event.start.at, end: step.event.end.at } : null;
  }

  // The Todo a live focus block was made from.
  function todoOf(event: Item): string | null {
    const link = itemStore.get(event.id)?.links.find((each) => each.type === 'made-from');
    return link && link.to.kind === 'todo' ? link.to.id : null;
  }

  // What the prompt says of a Todo, below its title.
  function linesOf(todo: Item, projects: Map<string, string>): string[] {
    const lines: string[] = [];
    const detail = todo.detail?.kind === 'todo' ? todo.detail : null;
    if (detail?.dueOn) lines.push(`Due: ${dayLabel(detail.dueOn)}`);
    const project = todo.filing ? projects.get(todo.filing.projectId) : undefined;
    if (project) lines.push(`Project: ${project}`);
    const issue = detail?.backedBy ? itemStore.get(detail.backedBy)?.item : undefined;
    if (issue?.detail?.kind === 'linear-issue') {
      const { identifier, priority, estimate } = issue.detail;
      const facts = [`Linear ${identifier}`, `priority ${PRIORITIES[priority] ?? 'No priority'}`];
      if (estimate !== null) facts.push(`estimate ${estimate}`);
      lines.push(facts.join(' · '));
    } else if (detail) {
      lines.push(`From: ${FROM[detail.origin] ?? 'added by the User'}`);
    }
    return lines;
  }

  // The most pressing first: due soonest, then Linear priority, then most recently changed.
  function pressing(a: Item, b: Item): number {
    const due = (item: Item) => (item.detail?.kind === 'todo' ? (item.detail.dueOn ?? '9999') : '9999');
    const priority = (item: Item) => {
      const backedBy = item.detail?.kind === 'todo' ? item.detail.backedBy : null;
      const issue = backedBy ? itemStore.get(backedBy)?.item : undefined;
      const value = issue?.detail?.kind === 'linear-issue' ? issue.detail.priority : 0;
      return value === 0 ? 5 : value;
    };
    return due(a).localeCompare(due(b)) || priority(a) - priority(b) || b.updatedAt - a.updatedAt;
  }

  return {
    job: BLOCK_TIME_FOR_TODOS,
    name: 'Block time for Todos',
    tier: 'deep',
    reasoningEffort: 'high',
    action: {
      action: BLOCK_TIME_FOR_TODOS,
      actionKind: 'tidy-sources',
      section: 'calendar',
      hint: 'Focus blocks for your Todos in your free time, in your Commander calendar',
    },
    triggers: { idle: true },

    gather({ triggers }) {
      const at = now();
      const zone = timeZone();
      const settings = itemStore.focusSettings.read();
      const account = focusAccountOf(settings.focusAccount, itemStore.calendars.list());
      if (!account) return null;
      const requested = triggers.some((trigger) => trigger.kind === 'request');
      if (!requested) {
        // The idle catch-up plans once per working day.
        if (!isWorkingDay(at, settings.workingHours, zone)) return null;
        const state = itemStore.agent.job(BLOCK_TIME_FOR_TODOS);
        const today = dayInZone(at, zone);
        const planned = state.lastOutcome === 'ok' || state.lastOutcome === 'nothing-to-do';
        if (state.lastRunAt !== null && planned && dayInZone(state.lastRunAt, zone) === today) return null;
      }

      const range = nextWorkingDays(at, WORKING_DAYS_AHEAD, settings.workingHours, zone);
      const waiting = proposalsOf(['pending']);
      const waitingTodos = new Set(waiting.map((record) => record.itemId));
      const waitingSlots = waiting.flatMap((record) => slotOf(record) ?? []);
      const events = itemStore
        .events({ from: range.from, to: range.to })
        .flatMap((event): FreeTimeEvent[] =>
          event.detail?.kind === 'event'
            ? [{ id: event.id, account: event.account, detail: event.detail }]
            : [],
        );
      const free = freeSlots({
        events,
        busy: waitingSlots,
        from: range.from,
        to: range.to,
        workingHours: settings.workingHours,
        timeZone: zone,
        minMinutes: MIN_SLOT_MINUTES,
      });

      // Focus blocks to come, and the Todos they are for.
      const focusBlocks = itemStore
        .events({ from: at, to: at + PLANNED_AHEAD_MS })
        .filter(
          (event) => event.detail?.kind === 'event' && event.detail.createdByCommander === 'focus-block',
        );
      const blocked = new Set(focusBlocks.flatMap((event) => todoOf(event) ?? []));
      const planned = focusBlocks
        .filter((event) => event.detail?.kind === 'event' && event.detail.start.at < range.to)
        .map((event) => ({
          start: event.detail?.kind === 'event' ? event.detail.start.at : 0,
          end: event.detail?.kind === 'event' ? event.detail.end.at : 0,
        }));

      const projects = new Map(itemStore.projects().map((project) => [project.id, project.name]));
      const todos = itemStore
        .query({ kinds: ['todo'], statuses: ['open'], limit: 1000 })
        .filter((todo) => !waitingTodos.has(todo.id) && !blocked.has(todo.id))
        .sort(pressing)
        .slice(0, MAX_TODOS);
      if (!free.length || !todos.length) return null;

      const dismissed = new Set(
        proposalsOf(['dismissed']).flatMap((record) => {
          const slot = slotOf(record);
          return slot ? [`${record.itemId}@${dayInZone(slot.start, zone)}`] : [];
        }),
      );
      const offered = todos.map((todo, index) => ({
        ref: `T${index + 1}`,
        todo,
        lines: linesOf(todo, projects),
      }));
      const today = dayInZone(at, zone);
      return {
        items: todos.map((todo) => ({ itemId: todo.id, fingerprint: today })),
        account,
        timeZone: zone,
        offered,
        free,
        planned,
        days: range.days,
        dismissed,
      };
    },

    prompt(input) {
      const zone = input.timeZone;
      const at = now();
      const lines = [
        `Time zone: ${zone}. Now: ${dayLabel(dayInZone(at, zone))} ${timeInZone(at, zone)}.`,
        '',
        'Free time:',
        ...input.days.map((day) => {
          const slots = input.free.filter((slot) => dayInZone(slot.start, zone) === day);
          const free = slots.length ? slots.map((slot) => span(slot, zone)).join(', ') : 'none';
          return `- ${dayLabel(day)} (${day}): ${free}`;
        }),
        '',
        'Focus blocks already planned:',
        ...(input.planned.length
          ? input.planned.map((slot) => `- ${dayLabel(dayInZone(slot.start, zone))} ${span(slot, zone)}`)
          : ['- none']),
      ];
      return {
        instructions: INSTRUCTIONS,
        data: [
          // Worked out by Commander from times alone: no words from any event.
          { label: 'Free time', from: 'user-settings', text: lines.join('\n') },
          ...input.offered.map(({ ref, todo, lines: facts }) => ({
            label: `Todo ${ref}`,
            from: todo,
            text: [`[${ref}] ${todo.title.replace(/\s+/g, ' ').trim()}`, ...facts].join('\n'),
          })),
        ],
      };
    },

    output: OUTPUT,

    proposals(output, input) {
      const zone = input.timeZone;
      const byRef = new Map(input.offered.map((offered) => [offered.ref, offered]));
      const dropped: string[] = [];
      const named = output.blocks.flatMap((block) => {
        const offered = byRef.get(block.todoId);
        if (!offered) {
          dropped.push(`it named ${block.todoId}, which it wasn’t given`);
          return [];
        }
        const [startDay, startTime] = block.start.split('T') as [string, string];
        const [endDay, endTime] = block.end.split('T') as [string, string];
        return [
          {
            ...block,
            offered,
            start: zonedTime(startDay, startTime, zone),
            end: zonedTime(endDay, endTime, zone),
          },
        ];
      });
      const { kept, dropped: refused } = checkFocusBlocks(named, input.free, {
        minMinutes: MIN_BLOCK_MINUTES,
      });
      for (const { block, why } of refused) dropped.push(`a block for ${block.todoId} was ${why}`);

      const proposals: JobProposal[] = kept.flatMap((block) => {
        const todo = itemStore.get(block.offered.todo.id)?.item;
        // Ticked off or deleted while Ares was thinking.
        if (!todo || todo.deletedAt !== null || todo.status !== 'open') {
          dropped.push(`${block.todoId} was done or gone by the time Ares answered`);
          return [];
        }
        if (input.dismissed.has(`${todo.id}@${dayInZone(block.start, zone)}`)) {
          dropped.push(`${block.todoId} was dismissed for that day before`);
          return [];
        }
        const time = (instant: number) => ({ at: instant, timeZone: zone, date: null });
        return [
          {
            itemId: todo.id,
            itemActions: [
              {
                type: 'create-event' as const,
                event: {
                  kind: 'focus-block' as const,
                  account: input.account,
                  title: cleanTitle(`Focus: ${todo.title}`),
                  start: time(block.start),
                  end: time(block.end),
                  filing: inheritedFiling(todo.filing),
                },
              },
              { type: 'link' as const, from: { step: 0 }, linkType: 'made-from' as const, to: todo.id },
            ],
            confidence: block.confidence,
            reason: block.reason,
            // About the Todo itself: chained (always Ask) whenever other outside Todos were read too.
            causedBy: { itemId: todo.id },
          },
        ];
      });
      return { proposals, dropped };
    },
  };
}

// The machine's time zone, which working hours are in.
function machineZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
