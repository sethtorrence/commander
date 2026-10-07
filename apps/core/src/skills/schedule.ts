// Schedule (#198, decisions #24, #17): the User tells Ares to set up time from a Conversation, and he
// uses the scheduler (#132) and focus time (#131) as they are. Free time is always worked out in code;
// the model only says who, how long and when, in words Commander turns into times on the User's own
// calendar (action-skills.ts).
//
// - A meeting ("find an hour with Priya next week", "set up a call with Leo Tuesday at 2"): the names
//   become addresses in code (propose-events.ts's guestResolver: an address must be in the User's
//   words or the Item it is about, or already known to them; a name nobody can place is left out, and
//   Ares is told). At a time the User named, the time is checked against every calendar; otherwise
//   Find time looks in the span they said (the next 5 working days when they said none), narrowed by
//   the guests' calendars where a provider shares them, and the event is prepared at the first time
//   everyone is free, the other times told to Ares. Its steps are the ones "Propose events" makes (the
//   calendar new events go in, guests invited by the Source, a made-from Link to the Item it is about),
//   under "Schedule", Act for you in the Calendar Section: it always waits for the User, as a card
//   they confirm with one key.
// - Focus time ("block two hours for the Acme Todo"): the first free slot that long in the span, in the
//   Commander calendar of the focus Account, busy and private, "Focus: <Todo>", with a made-from Link
//   to the Todo. Tidy your Sources ("Focus time", default Ask), as "Block time for Todos" is.
// - The booking link ("send Leo my booking link"): never an action of Ares's. A reply to the email or
//   Chat holding "Book a time here: <link>" in Commander's own words shows under the answer, which the
//   User opens in the composer (or the Chat's reply box) and sends themselves (ADR 0004, sixteenth
//   amendment).
//
// A proposal sits on the Item it is about (a Todo, an email), else on today's Daily Note, as Manage
// Todos' does. What Ares is told is Commander's own note: times, counts and refs, never a word from
// outside (not even a guest's name, which comes from a Source).
import {
  bestSlots,
  bookingLinkText,
  CONVERSATION_FOCUS_TIME,
  CONVERSATION_SCHEDULE,
  type ConversationMade,
  clashesAt,
  dayInZone,
  type FindTimeRequest,
  type FindTimeResult,
  type FreeTimeEvent,
  freeSlots,
  type Item,
  inheritedFiling,
  type ProposalRecord,
  type RegisteredAction,
  SCHEDULE_NEEDS,
  SCHEDULE_SKILL,
  type ScheduleInput,
  type Skill,
  type SkillContext,
  scheduleAt,
  scheduleInput,
  scheduleWindow,
  type TimeSlot,
  timeInZone,
} from '@commander/domain';
import { BLOCK_TIME_FOR_TODOS, focusAccountOf } from '../agent/block-time-for-todos';
import { guestResolver, meetingSteps, type PlannedEvent } from '../agent/propose-events';
import { attendeeDirectory, newEventsTarget } from '../scheduling';
import {
  type Acted,
  type Acting,
  type ActionSkillOptions,
  acting,
  actionFindings,
  registerActions,
} from './act';
import type { Findings } from './findings';

export const SCHEDULE_ACTION: RegisteredAction = {
  action: CONVERSATION_SCHEDULE,
  actionKind: 'act-for-you',
  name: 'Schedule',
  hint: 'Events with guests Ares prepares when you tell him to in a Conversation: always asked first, as others see them',
};

export const FOCUS_TIME_ACTION: RegisteredAction = {
  action: CONVERSATION_FOCUS_TIME,
  actionKind: 'tidy-sources',
  name: 'Focus time',
  hint: 'Focus time Ares blocks in your Commander calendar when you tell him to in a Conversation',
};

export type ScheduleSkillOptions = ActionSkillOptions & {
  // The scheduler's Find time: the User's free time, narrowed by guests' free/busy where it can be had.
  findTime: (request: FindTimeRequest) => Promise<FindTimeResult>;
  // The User's time zone, which working hours and their words are in (the machine's, unless given).
  timeZone?: () => string;
};

// A meeting with no length said, and how many other times Ares is told of.
const MEETING_MINUTES = 30;
const OTHER_TIMES = 3;
const MAX_TITLE = 120;

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function cleanTitle(title: string): string {
  const one = title
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。]+$/, '');
  return one.length > MAX_TITLE ? `${one.slice(0, MAX_TITLE - 1).trimEnd()}…` : one;
}

/** A time as the User reads it, on their own clock: "Tuesday 13 October, 10:00–11:00". */
export function slotWords(slot: TimeSlot, timeZone: string): string {
  const day = new Date(slot.start).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone,
  });
  return `${day}, ${timeInZone(slot.start, timeZone)}–${timeInZone(slot.end, timeZone)}`;
}

// What the addresses Ares names may be checked against beside what the User knows: the User's words,
// and the addresses on the email a meeting is about.
function writtenFor(context: SkillContext, from: Item | null): string {
  const detail = from?.detail?.kind === 'email' ? from.detail : null;
  const addresses = detail
    ? [detail.from, ...detail.to, ...detail.cc].map((each) => each?.address ?? '')
    : [];
  return [context.asked ?? '', ...addresses].join('\n');
}

export function createScheduleSkill(options: ScheduleSkillOptions): Skill<ScheduleInput, Findings> {
  const { itemStore, gate, findTime } = options;
  const now = options.now ?? Date.now;
  const timeZone = options.timeZone ?? machineZone;
  registerActions(gate, SCHEDULE_ACTION, FOCUS_TIME_ACTION);
  const title = SCHEDULE_SKILL.title as string;

  // The User's events between two instants, as free time reads them.
  const eventsBetween = (from: number, to: number) =>
    itemStore
      .events({ from, to })
      .flatMap((event): FreeTimeEvent[] =>
        event.detail?.kind === 'event'
          ? [{ id: event.id, account: event.account, detail: event.detail }]
          : [],
      );

  // Where a proposal about nothing in particular sits: today's Daily Note.
  const today = (zone: string) =>
    itemStore.ensureDailyNote(dayInZone(now(), zone), { by: { kind: 'user' } }, { fromTemplate: true });

  // The times other focus time already waits on (a suggestion not yet answered), so none is offered twice.
  const waitingFocus = (): TimeSlot[] =>
    [CONVERSATION_FOCUS_TIME, BLOCK_TIME_FOR_TODOS].flatMap((action) =>
      itemStore.autonomy
        .proposals({ action, statuses: ['pending'], limit: 500 })
        .flatMap((record: ProposalRecord) =>
          record.itemActions.flatMap((step) =>
            step.type === 'create-event' ? [{ start: step.event.start.at, end: step.event.end.at }] : [],
          ),
        ),
    );

  async function meeting(
    input: Extract<ScheduleInput, { action: 'meeting' }>,
    act: Acting,
    context: SkillContext,
  ): Promise<Findings> {
    const target = newEventsTarget(itemStore);
    if (!target) {
      return actionFindings(
        title,
        [],
        [
          'setting up the meeting: there is no calendar to put events in (the User can connect Google or Outlook Calendar in Settings → Accounts)',
        ],
      );
    }
    const from = input.from ? act.item(input.from) : null;
    const zone = timeZone();
    const at = now();
    const { attendees, guestsToFill } = guestResolver(attendeeDirectory(itemStore))(
      input.with,
      writtenFor(context, from),
    );
    const minutes = input.minutes ?? MEETING_MINUTES;
    const length = minutes * 60_000;
    const lines: string[] = [];
    let start: number;
    if (input.at) {
      start = scheduleAt(input.at, zone);
      if (start <= at)
        return actionFindings(title, [], ['setting up the meeting: that time has already passed']);
      const clashes = clashesAt({ start, end: start + length }, eventsBetween(start, start + length));
      lines.push(
        clashes.length
          ? `At that time the User already has ${plural(clashes.length, 'event')} in their calendar.`
          : 'The User is free then.',
      );
    } else {
      const window = scheduleWindow(input.when, at, zone, itemStore.focusSettings.read().workingHours);
      const found = await findTime({
        attendees: attendees.map((guest) => guest.email),
        durationMinutes: minutes,
        from: window.from,
        to: window.to,
      });
      const [first, ...others] = found.slots;
      if (!first) {
        return actionFindings(
          title,
          [],
          [
            `setting up the meeting: there is no time everyone is free for ${minutes} minutes in ${window.words}`,
          ],
        );
      }
      start = first.start;
      lines.push(`It is the first time everyone is free in ${window.words}.`);
      if (others.length)
        lines.push(
          `Other times everyone is free: ${others
            .slice(0, OTHER_TIMES)
            .map((slot) => slotWords(slot, zone))
            .join('; ')}. Tell the User they can ask for one of these instead.`,
        );
      const checked = found.guests.filter((guest) => guest.checked).length;
      const unchecked = found.guests.length - checked;
      if (checked)
        lines.push(`${plural(checked, 'guest’s calendar was', 'guests’ calendars were')} checked.`);
      if (unchecked)
        lines.push(
          `${plural(unchecked, 'guest’s calendar', 'guests’ calendars')} couldn’t be checked: only the User’s were.`,
        );
      const outside = found.guests.filter((guest) => guest.outside).length;
      if (outside && found.bookingLink)
        lines.push(
          `${plural(outside, 'guest is', 'guests are')} outside the User’s organisations: you may offer to put the User’s booking link in a reply instead (Schedule, "booking-link", on an email or Chat from them).`,
        );
    }
    if (guestsToFill.length)
      lines.push(
        `${plural(guestsToFill.length, 'person you named matches', 'people you named match')} no address Commander knows (or more than one person): the event would go without them unless the User gives you an address. Tell them.`,
      );

    const planned: PlannedEvent = {
      title: cleanTitle(input.title ?? `Meeting with ${input.with.join(', ')}`),
      attendees,
      guestsToFill: [],
      start,
      length,
      note: '',
      withGuests: true,
    };
    const anchor = from ?? today(zone);
    // A made-from Link only to an Item it is about, never to the Daily Note it sits on.
    const steps = meetingSteps(planned, target, anchor, zone).slice(0, from ? undefined : 1);
    const slot = { start, end: start + length };
    const acted: Acted[] = [
      act.propose({
        what: `put the meeting you asked for in the User’s calendar, ${slotWords(slot, zone)}, with ${plural(attendees.length, 'guest')} invited`,
        proposal: {
          actionKind: 'act-for-you',
          action: CONVERSATION_SCHEDULE,
          section: 'calendar',
          itemId: anchor.id,
          itemActions: steps,
        },
      }),
    ];
    return actionFindings(title, acted, [], { lines });
  }

  function focus(input: Extract<ScheduleInput, { action: 'focus' }>, act: Acting): Findings {
    const account = focusAccountOf(itemStore.focusSettings.read().focusAccount, itemStore.calendars.list());
    if (!account) {
      return actionFindings(
        title,
        [],
        [
          itemStore.calendars.list().length
            ? 'blocking focus time: no Account is chosen for focus time (the User can choose one in Settings → Calendar)'
            : 'blocking focus time: there is no calendar to block time in (the User can connect Google or Outlook Calendar in Settings → Accounts)',
        ],
      );
    }
    const todo = input.todo ? act.item(input.todo) : null;
    if (todo && todo.kind !== 'todo')
      return actionFindings(title, [], [`blocking focus time: ${input.todo} isn’t a Todo`]);
    if (todo && todo.status !== 'open')
      return actionFindings(title, [], [`blocking focus time: ${input.todo} is already done`]);
    const zone = timeZone();
    const at = now();
    const settings = itemStore.focusSettings.read();
    const window = scheduleWindow(input.when, at, zone, settings.workingHours);
    const free = freeSlots({
      events: eventsBetween(window.from, window.to),
      busy: waitingFocus(),
      from: window.from,
      to: window.to,
      workingHours: settings.workingHours,
      timeZone: zone,
      minMinutes: input.minutes,
    });
    const [first, ...others] = bestSlots({
      free,
      durationMinutes: input.minutes,
      count: OTHER_TIMES + 1,
      timeZone: zone,
    });
    if (!first) {
      return actionFindings(
        title,
        [],
        [`blocking focus time: the User has no ${input.minutes} minutes free in ${window.words}`],
      );
    }
    const what = todo?.title ?? input.title;
    const time = (instant: number) => ({ at: instant, timeZone: zone, date: null });
    const anchor = todo ?? today(zone);
    const acted: Acted[] = [
      act.propose({
        what: `block ${input.minutes} minutes of focus time${todo ? ` for ${input.todo}` : ''} in the User’s Commander calendar, ${slotWords(first, zone)}`,
        proposal: {
          actionKind: 'tidy-sources',
          action: CONVERSATION_FOCUS_TIME,
          section: 'calendar',
          itemId: anchor.id,
          itemActions: [
            {
              type: 'create-event',
              event: {
                kind: 'focus-block',
                account,
                title: cleanTitle(what ? `Focus: ${what}` : 'Focus time'),
                start: time(first.start),
                end: time(first.end),
                filing: inheritedFiling(todo?.filing ?? null),
              },
            },
            ...(todo
              ? [{ type: 'link' as const, from: { step: 0 }, linkType: 'made-from' as const, to: todo.id }]
              : []),
          ],
        },
      }),
    ];
    const lines = others.length
      ? [
          `Other free times: ${others.map((slot) => slotWords(slot, zone)).join('; ')}. Tell the User they can ask for one of these instead.`,
        ]
      : [];
    return actionFindings(title, acted, [], { lines });
  }

  function bookingLink(input: Extract<ScheduleInput, { action: 'booking-link' }>, act: Acting): Findings {
    const link = itemStore.schedulingSettings.read().bookingLink;
    if (!link) {
      return actionFindings(
        title,
        [],
        [
          'the booking link: the User hasn’t saved one (they can add their Google booking link in Settings → Calendar)',
        ],
      );
    }
    const item = act.item(input.to);
    const to = item.kind === 'email' ? 'email' : item.kind === 'chat' ? 'chat' : null;
    if (!to)
      return actionFindings(
        title,
        [],
        [`the booking link: ${input.to} isn’t an email or a Teams Chat to reply to`],
      );
    const made: ConversationMade = {
      kind: 'booking-reply',
      itemId: item.id,
      title: item.title,
      to,
      text: bookingLinkText(link),
      link,
    };
    return actionFindings(title, [], [], {
      lines: [
        `A reply to ${input.to} holding the User’s booking link is ready under your answer, for the User to open in the ${to === 'email' ? 'composer' : 'Chat’s reply box'} and send themselves. Nothing has been sent, and nothing is sent from a Conversation: never say it was.`,
      ],
      made: [made],
    });
  }

  return {
    ...SCHEDULE_SKILL,
    input: { schema: scheduleInput, describe: SCHEDULE_NEEDS },
    async run(input, context = {}) {
      const act = acting(context, options);
      if (input.action === 'meeting') return meeting(input, act, context);
      if (input.action === 'focus') return focus(input, act);
      return bookingLink(input, act);
    },
  };
}

// The machine's time zone, which working hours are in.
function machineZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
