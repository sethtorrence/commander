// Ares's "Propose events" job (#132, decision #19's job 6): the User writes "set up a call with Leo next
// week about the Acme renewal" in a Daily Note, and Ares offers a ready-made event beside the Block:
// "Call with Leo · 30 min · Tue 14:00, you're free". A Deep job at high thinking: one call, no tools, a
// reply that must fit OUTPUT.
//
// - Runs after a pause in typing in a Daily Note (as Suggest Todos does) on the changed Blocks that pass
//   a cheap pre-filter in code (a date, time or weekday, or a word like call, meet, catch up, sync or
//   lunch; the domain's `mightBeAboutMeeting`), and on request over today's note. Blocks are the User's
//   own words, so it reads no outside content; each goes with the Blocks above it as context.
// - Ares says who, how long and when (an exact time, or a window of days); everything else is code:
//   attendee names become addresses (an address written in the Block, then names on the User's events
//   and emails, then People; scheduling.ts), and a name it can't place is left blank on the card for the
//   User to fill in. An exact time is checked against the User's calendars across every Account (free,
//   or what it clashes with); a window gets the first free slot in it inside working hours.
// - Each event is a proposal on its Block: an event with guests is Act for you / "Create events with
//   guests" (always Ask, #11); time with nobody else is Tidy your Sources / "Hold time for yourself".
//   Create makes the event on the calendar chosen (Settings → Calendar → New events go in, changeable on
//   the card) through the create path every Commander event takes, guests invited by the Source, with a
//   made-from Link to the Block and the Block's Project.
// - The runner remembers each Block it sent with its text, so a dismissed proposal is never offered
//   again for the same text.
import {
  addDays,
  bestSlots,
  clashesAt,
  dayInZone,
  type FreeTimeEvent,
  freeSlots,
  type Item,
  imageAttachmentOf,
  inheritedFiling,
  type KnownAddress,
  mightBeAboutMeeting,
  type ResolvedAttendee,
  resolveAttendee,
  timeInZone,
  zonedTime,
} from '@commander/domain';
import { z } from 'zod';
import type { ItemStore } from '../item-store';
import { attendeeDirectory, newEventsTarget } from '../scheduling';
import type { AgentJob, JobInput, JobProposal } from './runner';
import { fingerprintOf, TYPING_PAUSE_MS } from './suggest-todos';

export const PROPOSE_EVENTS = 'propose-events';
// Its two actions: an event others see, and time for the User alone.
export const CREATE_EVENTS_WITH_GUESTS = 'create-events-with-guests';
export const HOLD_TIME = 'hold-time-for-yourself';

// At most this many Blocks per call; the rest wait for the next run.
const MAX_BLOCKS = 30;
const MAX_TITLE = 120;
// How far ahead the prompt lists days, so Ares can turn "Tuesday" into a date.
const DAYS_LISTED = 21;

const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'YYYY-MM-DDTHH:MM');
const localDay = z.iso.date();

export const OUTPUT = z.object({
  events: z
    .array(
      z.object({
        // The reference the prompt gave the Block (B1, B2…), never its id.
        blockId: z.string().min(1).max(20),
        title: z.string().trim().min(1).max(300),
        // The other people, as the User named them (a name or an address); empty for time alone.
        attendees: z.array(z.string().trim().min(1).max(200)).max(20),
        durationMinutes: z
          .number()
          .int()
          .min(5)
          .max(8 * 60),
        when: z.union([
          z.object({ at: localTime }),
          z.object({ window: z.object({ from: localDay, to: localDay }) }),
        ]),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(50),
});
type Output = z.infer<typeof OUTPUT>;

type Offered = { ref: string; item: Item; text: string };
type Input = JobInput & {
  offered: Offered[];
  notes: { title: string; lines: string[]; blocks: Item[] }[];
  timeZone: string;
};

const INSTRUCTIONS = `You are Ares. You spot the meetings, calls and time the User wants to set up in their own Daily Note, and propose each as a calendar event.

Each line in the data is a Block the User wrote; Blocks sit under the Blocks above them. Only the Blocks marked with a reference ([B1], [B2]…) are for you to judge; the others are context. For each marked Block, decide whether the User wants an event set up: a call, meeting, catch-up, sync, lunch, or time held for something ("set up a call with Leo next week about the Acme renewal", "call with Leo Tuesday at 2", "lunch with Sam Friday", "block Thursday morning for the report").

These are not events to set up: notes about meetings that already happened ("met Dana, she wants a discount"), things to do that need no time together ("send Leo the deck"), meetings someone else will set up, and plain dates or deadlines ("report due Friday").

Reply with only this JSON object: {"events":[{"blockId":"B1","title":"Call with Leo","attendees":["Leo"],"durationMinutes":30,"when":{"at":"2026-10-06T14:00"},"confidence":0.9}]}
- One entry per marked Block that asks for an event. Leave the others out; an empty list is fine.
- blockId: the Block's reference, exactly as marked.
- title: a short event title in the User's words, like "Call with Leo" or "Acme renewal: call with Leo". No full stop.
- attendees: the other people, each exactly as the User wrote them (a first name, a full name, or an email address). Not the User. An empty list for time the User holds for themself.
- durationMinutes: as the User said; otherwise 30 for a call or catch-up, 60 for a meeting or lunch.
- when: {"at":"YYYY-MM-DDTHH:MM"} for a day and time the User gave, in their time zone, using the days listed in the data ("Tuesday at 2" is the coming Tuesday at 14:00 unless they plainly mean 2am). {"window":{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}} when they gave only a day or a span ("next week", "Friday", "before the 20th"); with no time at all, the next 5 working days.
- confidence: how sure you are the User wants this event set up, from 0 to 1.`;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Tue 6 Oct", for a day.
function dayLabel(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${date} ${MONTHS[month - 1]}`;
}

const textOf = (item: Item) => (item.detail?.kind === 'block' ? item.detail.text : '');
const parentOf = (item: Item) => (item.detail?.kind === 'block' ? item.detail.parentId : null);

function cleanTitle(title: string): string {
  const one = title
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。]+$/, '');
  return one.length > MAX_TITLE ? `${one.slice(0, MAX_TITLE - 1).trimEnd()}…` : one;
}

export function proposeEventsJob(
  itemStore: ItemStore,
  { now = Date.now, timeZone = machineZone }: { now?: () => number; timeZone?: () => string } = {},
): AgentJob<Input, Output> {
  const waiting = (blockId: string) =>
    itemStore.autonomy
      .proposals({ itemId: blockId, statuses: ['pending'] })
      .some((proposal) => proposal.action === CREATE_EVENTS_WITH_GUESTS || proposal.action === HOLD_TIME);

  // A live, written Block that might be about a meeting and has no proposal waiting.
  function candidate(itemId: string): Item | null {
    const item = itemStore.get(itemId)?.item;
    if (item?.kind !== 'block' || item.deletedAt !== null) return null;
    const text = textOf(item).trim();
    if (!text || imageAttachmentOf(text) || !mightBeAboutMeeting(text)) return null;
    if (waiting(itemId)) return null;
    return item;
  }

  // Each Daily Note's offered Blocks as an outline, with the Blocks above them as context lines.
  function outlines(blocks: Item[]): { offered: Offered[]; notes: Input['notes'] } {
    const byNote = new Map<string, Set<string>>();
    for (const block of blocks) {
      if (block.detail?.kind !== 'block') continue;
      const ids = byNote.get(block.detail.dailyNoteId) ?? new Set<string>();
      byNote.set(block.detail.dailyNoteId, ids.add(block.id));
    }
    const offered: Offered[] = [];
    const notes: Input['notes'] = [];
    for (const [noteId, wanted] of byNote) {
      const note = itemStore.get(noteId)?.item;
      if (note?.detail?.kind !== 'daily-note') continue;
      const all = itemStore.blocks([noteId]);
      const byId = new Map(all.map((block) => [block.id, block]));
      const shown = new Set<string>();
      for (const id of wanted) {
        for (let at: string | null = id; at && !shown.has(at); at = parentOf(byId.get(at) as Item)) {
          if (!byId.has(at)) break;
          shown.add(at);
        }
      }
      const children = new Map<string | null, Item[]>();
      for (const block of all) {
        if (!shown.has(block.id)) continue;
        children.set(parentOf(block), [...(children.get(parentOf(block)) ?? []), block]);
      }
      const lines: string[] = [];
      const listed: Item[] = [];
      const position = (block: Item) => (block.detail?.kind === 'block' ? block.detail.position : '');
      const walk = (parent: string | null, depth: number) => {
        const kids = [...(children.get(parent) ?? [])].sort((a, b) => (position(a) < position(b) ? -1 : 1));
        for (const block of kids) {
          let mark = '';
          if (wanted.has(block.id)) {
            const ref = `B${offered.length + 1}`;
            offered.push({ ref, item: block, text: textOf(block).trim() });
            mark = `[${ref}] `;
          }
          listed.push(block);
          lines.push(
            `${'  '.repeat(depth)}- ${mark}${textOf(block)
              .replace(/\s*\n\s*/g, ' ')
              .trim()}`,
          );
          walk(block.id, depth + 1);
        }
      };
      walk(null, 0);
      notes.push({ title: note.title, lines, blocks: listed });
    }
    return { offered, notes };
  }

  // The User's events between two instants, as free time reads them.
  const eventsBetween = (from: number, to: number) =>
    itemStore
      .events({ from, to })
      .flatMap((event): (FreeTimeEvent & { title: string })[] =>
        event.detail?.kind === 'event'
          ? [{ id: event.id, account: event.account, title: event.title, detail: event.detail }]
          : [],
      );

  return {
    job: PROPOSE_EVENTS,
    name: 'Propose events',
    tier: 'deep',
    reasoningEffort: 'high',
    action: {
      action: CREATE_EVENTS_WITH_GUESTS,
      actionKind: 'act-for-you',
      section: 'calendar',
      name: 'Create events with guests',
      hint: 'Events with guests from what you write in your Daily Notes: always a suggestion, as others see them',
    },
    alsoActions: [
      {
        action: HOLD_TIME,
        actionKind: 'tidy-sources',
        section: 'calendar',
        name: 'Hold time for yourself',
        hint: 'Time for you alone from what you write in your Daily Notes, in your own calendar',
      },
    ],
    triggers: { typing: { pauseMs: TYPING_PAUSE_MS } },

    gather({ triggers, cursor, seen }) {
      const changes = itemStore.agent.userChangesSince(cursor, ['block']);
      const ids = new Set(cursor === null ? [] : changes.itemIds);
      for (const trigger of triggers)
        if ('itemIds' in trigger) for (const id of trigger.itemIds ?? []) ids.add(id);
      // Asked for (or its first run): today's note too.
      if (cursor === null || triggers.some((trigger) => trigger.kind === 'request')) {
        const day = dayInZone(now(), timeZone());
        const today = itemStore.dailyNotes({ from: day, to: day, limit: 1 }).notes[0];
        if (today) for (const block of itemStore.blocks([today.item.id])) ids.add(block.id);
      }
      // Nowhere to put an event: nothing to propose (and the Blocks wait until there is).
      if (!newEventsTarget(itemStore)) return null;
      const blocks = [...ids]
        .map(candidate)
        .filter((item): item is Item => item !== null && !seen(item.id, fingerprintOf(textOf(item))));
      const taken = blocks.slice(0, MAX_BLOCKS);
      const next = blocks.length > MAX_BLOCKS ? (cursor ?? undefined) : changes.lastEntryId;
      const { offered, notes } = outlines(taken);
      return {
        items: offered.map(({ item, text }) => ({ itemId: item.id, fingerprint: fingerprintOf(text) })),
        ...(next !== undefined && next !== null && { cursor: next }),
        offered,
        notes,
        timeZone: timeZone(),
      };
    },

    prompt(input) {
      const zone = input.timeZone;
      const at = now();
      const today = dayInZone(at, zone);
      const days = Array.from({ length: DAYS_LISTED }, (_, index) => addDays(today, index));
      const calendar = [
        `Time zone: ${zone}. Now: ${dayLabel(today)} (${today}) ${timeInZone(at, zone)}.`,
        `The days ahead: ${days.map((day) => `${dayLabel(day)} = ${day}`).join('; ')}.`,
      ].join('\n');
      return {
        instructions: INSTRUCTIONS,
        data: [
          // Worked out by Commander from the clock alone.
          { label: 'Today', from: 'user-settings', text: calendar },
          ...input.notes.map((note) => ({
            label: `Daily Note · ${note.title}`,
            from: note.blocks,
            text: note.lines.join('\n'),
          })),
        ],
      };
    },

    output: OUTPUT,

    proposals(output, input) {
      const zone = input.timeZone;
      const at = now();
      const byRef = new Map(input.offered.map((offered) => [offered.ref, offered]));
      const target = newEventsTarget(itemStore);
      const dropped: string[] = [];
      if (!target) return { proposals: [], dropped: ['there is no calendar to put events in'] };
      const directory = attendeeDirectory(itemStore);
      const known = new Set<string>(
        [...directory.seen, ...directory.people].map((each: KnownAddress) => each.email),
      );
      const settings = itemStore.focusSettings.read();
      const used = new Set<string>();

      const proposals = output.events.flatMap((proposed): JobProposal[] => {
        const offered = byRef.get(proposed.blockId);
        if (!offered) {
          dropped.push(`it named ${proposed.blockId}, which it wasn’t given`);
          return [];
        }
        if (used.has(proposed.blockId)) {
          dropped.push(`it named ${proposed.blockId} twice`);
          return [];
        }
        used.add(proposed.blockId);
        const block = candidate(offered.item.id);
        if (!block || fingerprintOf(textOf(block)) !== fingerprintOf(offered.text)) {
          dropped.push(`${proposed.blockId} changed while Ares was looking at it`);
          return [];
        }

        // Who: addresses in code. An address must be written in the Block or already known to the User.
        const written = offered.text.toLowerCase();
        const guests: ResolvedAttendee[] = proposed.attendees.map((name) => {
          const resolved = resolveAttendee(name, directory);
          if (
            resolved.how === 'address' &&
            !written.includes(resolved.email ?? '') &&
            !known.has(resolved.email ?? '')
          )
            return { name: resolved.name, email: null, how: null };
          return resolved;
        });
        const attendees = [
          ...new Map(
            guests.flatMap((guest) =>
              guest.email
                ? [
                    [
                      guest.email,
                      { email: guest.email, name: guest.name === guest.email ? null : guest.name },
                    ] as const,
                  ]
                : [],
            ),
          ).values(),
        ];
        const guestsToFill = [
          ...new Set(guests.flatMap((guest) => (!guest.email && guest.name ? [guest.name] : []))),
        ];

        // When: an exact time as said; a window's first free slot inside working hours.
        const length = proposed.durationMinutes * 60_000;
        let start: number;
        let note: string;
        if ('at' in proposed.when) {
          const [day, time] = proposed.when.at.split('T') as [string, string];
          start = zonedTime(day, time, zone);
          if (start <= at) {
            dropped.push(`${proposed.blockId} named a time already past`);
            return [];
          }
          const clashes = clashesAt({ start, end: start + length }, eventsBetween(start, start + length));
          note = clashes.length
            ? `It clashes with ${clashes.map((each) => `“${each.title}”`).join(' and ')}.`
            : 'You’re free then.';
        } else {
          const { from, to } = proposed.when.window;
          const windowFrom = Math.max(at, zonedTime(from, '00:00', zone));
          const windowTo = zonedTime(addDays(to < from ? from : to), '00:00', zone);
          const free = freeSlots({
            events: eventsBetween(windowFrom, windowTo),
            from: windowFrom,
            to: windowTo,
            workingHours: settings.workingHours,
            timeZone: zone,
            minMinutes: proposed.durationMinutes,
          });
          const [first] = bestSlots({
            free,
            durationMinutes: proposed.durationMinutes,
            count: 1,
            timeZone: zone,
          });
          if (!first) {
            dropped.push(`${proposed.blockId} has no free time in ${from}–${to}`);
            return [];
          }
          start = first.start;
          note = 'It’s the first time you’re free then.';
        }

        const withGuests = attendees.length > 0 || guestsToFill.length > 0;
        const time = (instant: number) => ({ at: instant, timeZone: zone, date: null });
        return [
          {
            itemId: block.id,
            itemActions: [
              {
                type: 'create-event' as const,
                event: {
                  kind: 'meeting' as const,
                  account: target.account,
                  calendarId: target.calendarId,
                  title: cleanTitle(proposed.title),
                  start: time(start),
                  end: time(start + length),
                  attendees,
                  guestsToFill,
                  filing: inheritedFiling(block.filing),
                },
              },
              { type: 'link' as const, from: { step: 0 }, linkType: 'made-from' as const, to: block.id },
            ],
            confidence: proposed.confidence,
            reason: `You wrote “${offered.text}” in your Daily Note. ${note}`,
            ...(!withGuests && {
              as: { action: HOLD_TIME, actionKind: 'tidy-sources' as const, section: 'calendar' as const },
            }),
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
