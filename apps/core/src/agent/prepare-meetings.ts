// "Prepare for meetings" (#130): half an hour before a meeting, Ares has done the homework. A Deep job
// at high thinking, registered as Organise / "Prepare for meetings".
//
// - When: 30 minutes before each meeting that gets a chip and has someone else in it (`at` triggers,
//   planned again after each calendar sync; one missed while the machine slept runs on waking if the
//   meeting hasn't started, and is dropped otherwise), and on request (Prepare now on a chip or an
//   event). A prep stands for the event as it was when prepared (its revision): a timed run with a prep
//   for the event as it is now makes no call; Prepare now always does.
// - What it reads is gathered by code (meeting-material.ts): the event, the notes under earlier
//   meetings' chips, and the other people's open Items and those linked to the event, capped at 40 and
//   cut to a budget of characters so the call stays small. Every block goes through the prompt builder
//   (ADR 0004): the invitation and each outside Item in a data block of its own, labelled with the
//   reference (S1, S2…) the reply names its sources by.
// - The reply is { about, lastTime[], open[], raise[] }, each line naming the references it rests on;
//   a line naming none it was given is dropped. The prep is a view: it changes no Item of the User's or
//   a Source's, and is drawn only with AresText, so the runner `apply`s it at any level above Off (Ask
//   works as Auto here: there is nothing to approve), like the Dashboard's ranking. It is kept as an
//   Item made by Ares (kind meeting-prep) with an about Link to the event and refers-to Links to its
//   sources (ADR 0004's second amendment); re-running replaces it, Links and all.
// - A ready prep queues "Needs you now" in the Update ("Prep for “1:1 with Priya” at 15:00 is ready"),
//   expiring when the meeting ends.
// - Todos the meeting asks for ("please read the deck before Thursday") come from a second call that
//   reads the invitation alone, so each is a suggestion about the event itself (not a chained one).
//   Each goes to the gate as a proposal to Organise / "Suggest Todos": a Todo of Ares's, made from the
//   event, in its Project, due the meeting's day; the gate adds it or leaves it on the chip to Add or
//   Dismiss. One already offered for the event (any answer) is never offered again.
import { randomUUID } from 'node:crypto';
import {
  type Enqueue,
  type EventDetail,
  eventRevision,
  type Item,
  type ItemAction,
  inheritedFiling,
  isEvent,
  isMeetingPrep,
  isPrepWorthy,
  localDay,
  type MeetingPrepDetail,
  meetingTimes,
  PREP_LEAD_MS,
  PREPARE_MEETINGS,
  PREPARE_MEETINGS_NAME,
  type PrepLine,
  prepSources,
  prepTitle,
} from '@commander/domain';
import { z } from 'zod';
import type { ItemStore } from '../item-store';
import { gatherMeetingMaterial, type MeetingMaterial } from './meeting-material';
import type { PromptData } from './prompt';
import type { AgentJob, JobInput, JobProposal, PlannedRun } from './runner';
import { SUGGEST_TODOS } from './suggest-todos';

type Event = Item & { detail: EventDetail };

const HOUR = 3_600_000;
// Meetings are planned for this far ahead (calendar syncs and the hourly re-plan keep it current).
const PLAN_AHEAD_MS = 36 * HOUR;
// At most this many meetings a run (a request with none named looks at the rest of today's).
const MAX_MEETINGS = 5;
// Bounds on what one call reads: the invitation, each Item, each note line, and all Items together.
const MAX_DESCRIPTION = 2_000;
const MAX_ITEM_TEXT = 600;
const MAX_NOTE_LINE = 200;
const ITEMS_BUDGET = 16_000;
const MAX_LINES = 5;
const MAX_LINE_CHARS = 300;
const MAX_TODO_TITLE = 120;
// Below this, a Todo the meeting asks for isn't worth offering.
const MIN_TODO_CONFIDENCE = 0.3;

const ref = z.string().max(20);
const line = z
  .object({ text: z.string().max(2_000), sources: z.array(ref).max(20).optional().default([]) })
  .nullable()
  .catch(null);
const todo = z
  .object({
    title: z.string().max(600),
    sources: z.array(ref).max(20).optional().default([]),
    confidence: z.number().min(0).max(1),
  })
  .nullable()
  .catch(null);
// One shape for both calls: the prep's fields, or (reading the invitation alone) the Todos it asks for.
export const OUTPUT = z.object({
  about: line.optional().default(null),
  lastTime: z.array(line).max(20).optional().default([]),
  open: z.array(line).max(20).optional().default([]),
  raise: z.array(line).max(20).optional().default([]),
  todos: z.array(todo).max(10).optional().default([]),
});
type Output = z.infer<typeof OUTPUT>;

type Source = { ref: string; itemId: string; data: PromptData };
type Meeting = { event: Event; revision: string; sources: Source[] };
type Part = 'prep' | 'asks';
type Input = JobInput & { meetings: Meeting[]; part?: Part };

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
const longDay = (at: number) => {
  const date = new Date(at);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
};
const pad = (n: number) => String(n).padStart(2, '0');
const clock = (at: number) => `${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}`;
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const cut = (text: string, length: number) => {
  const one = oneLine(text);
  return one.length > length ? `${one.slice(0, length - 1).trimEnd()}…` : one;
};
// Paragraphs kept, but cut to a length.
const cutKeepingLines = (text: string, length: number) => {
  const trimmed = text.trim();
  return trimmed.length > length ? `${trimmed.slice(0, length - 1).trimEnd()}…` : trimmed;
};

const prepInstructions = (
  now: number,
  event: Event,
) => `You are Ares. You prepare the User for a meeting that starts soon, so they walk in knowing what it is about, what was said last time, what is open with the people in it, and anything worth raising.

Today is ${longDay(now)}; the time is ${clock(now)}. The meeting is on ${longDay(event.detail.start.at)} at ${meetingTimes(event.detail)}.

Each data block is labelled with its reference (S1, S2…) and what it is. S1 is the meeting's invitation. A block of notes holds what the User wrote under an earlier meeting with the same people. The other blocks are Items involving the people in the meeting.

Reply with only this JSON object: {"about":{"text":"…","sources":["S1"]},"lastTime":[{"text":"…","sources":["S2"]}],"open":[…],"raise":[…]}
- about: what the meeting is about, in one short sentence.
- lastTime: what was said, agreed or promised last time, from the notes of earlier meetings; empty when there are none.
- open: what is open with the people in the meeting: their issues, pull requests, emails or chats still waiting on someone.
- raise: anything worth raising in the meeting (a decision needed, something blocked, a promise due).
- Each line is one short, plain sentence (fewer than 25 words), as you would say it to the User, with "sources": the references of the blocks it rests on, exactly as labelled. Leave out anything no block supports. At most ${MAX_LINES} lines in each list, the most useful first.`;

const ASKS_INSTRUCTIONS = `You are Ares. You read a meeting's invitation for anything it asks the User to do before or at the meeting: "please read the deck before Thursday", "bring the Q3 numbers", "fill in the survey first". The data block S1 is the invitation.

Reply with only this JSON object: {"todos":[{"title":"…","sources":["S1"],"confidence":0.9}]}
- One entry for each thing the invitation asks the User to do; an empty list when it asks nothing of them. Things for other people, the meeting itself, and its agenda are not things to do.
- title: the thing to do as a short instruction starting with a verb, in the invitation's words: "Read the deck". Keep names, dates and numbers. No full stop.
- confidence: how sure you are that the invitation asks the User to do it, from 0 to 1.`;

const KIND_NAMES: Partial<Record<Item['kind'], string>> = {
  'linear-issue': 'Linear issue',
  'pull-request': 'Pull request',
  'review-request': 'Review request',
  email: 'Email',
  chat: 'Teams Chat',
  'channel-post': 'Teams post',
  todo: 'Todo',
  block: 'Note',
};

const personName = (person: { email: string; name: string | null; self: boolean }) =>
  person.self ? 'the User' : person.name ? `${person.name} <${person.email}>` : person.email;

// The invitation as the model reads it.
function eventText(event: Event): string {
  const { detail } = event;
  const guests = detail.attendees
    .filter((each) => !each.resource)
    .map((each) => `${personName(each)} (${each.response}${each.optional ? ', optional' : ''})`);
  return [
    `Title: ${event.title}`,
    `When: ${longDay(detail.start.at)}, ${meetingTimes(detail)}`,
    ...(detail.organiser ? [`Organiser: ${personName(detail.organiser)}`] : []),
    ...(guests.length ? [`Guests: ${guests.join('; ')}`] : []),
    ...(detail.location ? [`Where: ${cut(detail.location, 200)}`] : []),
    ...(detail.description?.trim()
      ? [`Description:\n${cutKeepingLines(detail.description, MAX_DESCRIPTION)}`]
      : []),
  ].join('\n');
}

// An Item involving the people in the meeting, as the model reads it.
function itemText(item: Item): string {
  const lines = [`Title: ${item.title}`, `Last changed: ${localDay(item.updatedAt)}`];
  const detail = item.detail;
  if (detail?.kind === 'linear-issue') {
    lines.push(`State: ${detail.state.name}`);
    if (detail.assignee) lines.push(`Assigned to: ${detail.assignee.name}`);
    if (detail.dueDate) lines.push(`Due: ${detail.dueDate}`);
    if (detail.description) lines.push(`Description: ${cut(detail.description, 300)}`);
    const latest = detail.comments.at(-1);
    if (latest) lines.push(`Latest comment (${latest.author?.name ?? 'someone'}): ${cut(latest.body, 200)}`);
  } else if (detail?.kind === 'chat') {
    for (const message of detail.messages.filter((each) => !each.deleted && !each.event).slice(-3)) {
      lines.push(`${message.from?.name ?? 'Someone'}: ${cut(message.text, 150)}`);
    }
  } else if (detail?.kind === 'email') {
    const from = detail.from;
    if (from) lines.push(`From: ${from.name ? `${from.name} <${from.address}>` : from.address}`);
    if (detail.sentByMe) lines.push('Sent by the User');
    if (detail.snippet) lines.push(`Preview: ${cut(detail.snippet, 300)}`);
  } else if (detail?.kind === 'todo') {
    if (detail.dueOn) lines.push(`Due: ${detail.dueOn}`);
  } else if (detail?.kind === 'block') {
    lines[0] = `Text: ${cut(detail.text, 300)}`;
  }
  return cutKeepingLines(lines.join('\n'), MAX_ITEM_TEXT);
}

const label = (item: Item) => {
  const what = KIND_NAMES[item.kind] ?? 'Item';
  if (item.detail?.kind === 'linear-issue') return `${what} ${item.detail.identifier} · ${item.title}`;
  if (item.detail?.kind === 'block') return what;
  return `${what} · ${item.title}`;
};

// The blocks a meeting's prompt is made of, each with its reference: the invitation, the earlier
// notes, then the Items, newest first, while they fit the budget.
function sourcesOf(material: MeetingMaterial): Source[] {
  const sources: Source[] = [];
  const add = (itemId: string, data: Omit<PromptData, 'label'> & { what: string }) => {
    const ref = `S${sources.length + 1}`;
    sources.push({ ref, itemId, data: { label: `${ref} · ${data.what}`, from: data.from, text: data.text } });
  };
  const { event } = material;
  add(event.id, { what: `Meeting · ${event.title}`, from: event, text: eventText(event) });
  for (const meeting of material.earlier) {
    add(meeting.chip.id, {
      what: `Notes from the meeting on ${meeting.day}`,
      from: meeting.lines.map((each) => each.block),
      text: meeting.lines
        .map((each) => `${'  '.repeat(each.depth)}- ${cut(each.text, MAX_NOTE_LINE)}`)
        .join('\n'),
    });
  }
  let spent = 0;
  for (const item of material.items) {
    const text = itemText(item);
    if (spent + text.length > ITEMS_BUDGET) break;
    spent += text.length;
    add(item.id, { what: label(item), from: item, text });
  }
  return sources;
}

// A line of the reply, kept only when it names a source it was given: its text cleaned, its
// references turned into Item ids.
function toLine(raw: Output['open'][number], byRef: Map<string, string>, dropped: string[]): PrepLine | null {
  if (!raw) {
    dropped.push('a line that wasn’t one');
    return null;
  }
  const text = cut(raw.text, MAX_LINE_CHARS);
  const sources = [...new Set(raw.sources.flatMap((each) => byRef.get(each.trim().toUpperCase()) ?? []))];
  if (!text) {
    dropped.push('an empty line');
    return null;
  }
  if (!sources.length) {
    dropped.push(`a line naming no source it was given (${raw.sources.join(', ') || 'none'})`);
    return null;
  }
  return { text, sources };
}

const cleanTitle = (title: string) => cut(title.replace(/[.。]+\s*$/, ''), MAX_TODO_TITLE);

export type PrepareMeetingsOptions = {
  now?: () => number;
  // Ares's queue for the Update: a ready prep is "Needs you now".
  enqueue: (input: Enqueue) => unknown;
  // Items the job changed outside the gate (a prep and its event), so open views catch up.
  onItemsChanged?: (itemIds: string[]) => void;
};

export function prepareMeetingsJob(
  itemStore: ItemStore,
  { now = Date.now, enqueue, onItemsChanged }: PrepareMeetingsOptions,
): AgentJob<Input, Output> {
  const eventOf = (id: string): Event | null => {
    const item = itemStore.get(id)?.item;
    return isEvent(item) ? item : null;
  };
  const currentPrep = (eventId: string) => {
    const prep = itemStore.meetingPreps([eventId])[0];
    return isMeetingPrep(prep) ? prep : null;
  };

  // The meetings ahead that are prepared for, earliest first.
  function upcoming(from: number, to: number): Event[] {
    return itemStore
      .events({ from, to })
      .filter(
        (item): item is Event =>
          isPrepWorthy(item) && item.detail.start.at > from && item.detail.start.at < to,
      )
      .sort((a, b) => a.detail.start.at - b.detail.start.at);
  }

  function plan(at: number): PlannedRun[] {
    return upcoming(at, at + PLAN_AHEAD_MS).map((event) => ({
      // Each revision once: a meeting moved or changed is planned (and prepared) again.
      key: `${event.id}:${eventRevision(event)}`,
      at: event.detail.start.at - PREP_LEAD_MS,
      until: event.detail.start.at,
      itemIds: [event.id],
    }));
  }

  // Saves the prep: a new Item with its Links, or the existing one changed and its Links following.
  function save(event: Event, detail: MeetingPrepDetail): string {
    const title = prepTitle(event.title);
    const wanted = new Set(prepSources(detail).filter((id) => id !== event.id));
    const existing = currentPrep(event.id);
    const actions: ItemAction[] = [];
    let prepId: string;
    if (existing) {
      prepId = existing.id;
      actions.push({ type: 'update', itemId: prepId, changes: { title, detail, status: 'open' } });
      const links = itemStore.get(prepId)?.links ?? [];
      const has = new Set<string>();
      for (const link of links) {
        if (link.type !== 'refers-to' || link.to.kind === 'project') continue;
        if (wanted.has(link.to.id)) has.add(link.to.id);
        else actions.push({ type: 'unlink', from: prepId, linkType: 'refers-to', to: link.to.id });
      }
      for (const id of wanted) {
        if (!has.has(id)) actions.push({ type: 'link', from: prepId, linkType: 'refers-to', to: id });
      }
      if (!links.some((link) => link.type === 'about' && link.to.id === event.id)) {
        actions.push({ type: 'link', from: prepId, linkType: 'about', to: event.id });
      }
    } else {
      prepId = randomUUID();
      actions.push(
        { type: 'create', item: { id: prepId, kind: 'meeting-prep', title, detail } },
        { type: 'link', from: prepId, linkType: 'about', to: event.id },
        ...[...wanted].map((id) => ({
          type: 'link' as const,
          from: prepId,
          linkType: 'refers-to' as const,
          to: id,
        })),
      );
    }
    itemStore.recordAll(actions, {
      by: { kind: 'ares' },
      why: `Ares prepared for “${oneLine(event.title)}”`,
      causedBy: { itemId: event.id },
    });
    return prepId;
  }

  // The Todos already offered for an event (any answer) and those made from it, by title.
  function offered(eventId: string): Set<string> {
    const titles = new Set<string>();
    for (const proposal of itemStore.autonomy.proposals({
      itemId: eventId,
      action: SUGGEST_TODOS,
      limit: 500,
    })) {
      for (const step of proposal.itemActions) {
        if (step.type === 'create' && step.item.kind === 'todo') titles.add(step.item.title.toLowerCase());
      }
    }
    for (const link of itemStore.get(eventId)?.backlinks ?? []) {
      if (link.type === 'made-from' && link.from.kind === 'todo') titles.add(link.from.title.toLowerCase());
    }
    return titles;
  }

  return {
    job: PREPARE_MEETINGS,
    name: PREPARE_MEETINGS_NAME,
    tier: 'deep',
    reasoningEffort: 'high',
    action: {
      action: PREPARE_MEETINGS,
      actionKind: 'organise',
      section: 'calendar',
      hint: 'A short prep under each meeting chip, half an hour before. Ask works as Auto here: there is nothing to approve',
    },
    triggers: { at: { plan } },

    gather({ triggers }) {
      const at = now();
      // Each meeting asked about, and whether the User asked (Prepare now always prepares again).
      const wanted = new Map<string, boolean>();
      for (const trigger of triggers) {
        if (trigger.kind === 'request' && trigger.itemIds?.length) {
          for (const id of trigger.itemIds) wanted.set(id, true);
        } else if (trigger.kind === 'request') {
          // Asked with none named (Settings → Ares): the rest of today's meetings not yet prepared.
          const end = new Date(at);
          end.setHours(24, 0, 0, 0);
          for (const event of upcoming(at, end.getTime()))
            if (!wanted.has(event.id)) wanted.set(event.id, false);
        } else if (trigger.kind === 'at') {
          for (const id of trigger.itemIds) if (!wanted.has(id)) wanted.set(id, false);
        }
      }
      const meetings: Meeting[] = [];
      for (const [id, asked] of wanted) {
        if (meetings.length >= MAX_MEETINGS) break;
        const event = eventOf(id);
        // Declined, cancelled, or no one else in it: never prepared.
        if (!event || !isPrepWorthy(event)) continue;
        const revision = eventRevision(event);
        if (!asked) {
          // Started already, or prepared for as it is now: nothing to do.
          if (event.detail.start.at <= at) continue;
          if (currentPrep(event.id)?.detail.revision === revision) continue;
        }
        meetings.push({ event, revision, sources: sourcesOf(gatherMeetingMaterial(itemStore, event)) });
      }
      return {
        items: meetings.map(({ event, revision }) => ({ itemId: event.id, fingerprint: revision })),
        meetings,
      };
    },

    // Each meeting a call of its own, and a second reading its invitation alone when it has words.
    batch(input) {
      return input.meetings.flatMap((meeting) => {
        const items = [{ itemId: meeting.event.id, fingerprint: meeting.revision }];
        const parts: Input[] = [{ items, meetings: [meeting], part: 'prep' }];
        if (meeting.event.detail.description?.trim())
          parts.push({ items, meetings: [meeting], part: 'asks' });
        return parts;
      });
    },

    prompt(input) {
      const meeting = input.meetings[0];
      if (!meeting) return { instructions: ASKS_INSTRUCTIONS, data: [] };
      if (input.part === 'asks') {
        return {
          instructions: ASKS_INSTRUCTIONS,
          data: meeting.sources.slice(0, 1).map((each) => each.data),
        };
      }
      return {
        instructions: prepInstructions(now(), meeting.event),
        data: meeting.sources.map((each) => each.data),
      };
    },

    output: OUTPUT,

    apply(answers) {
      const dropped: string[] = [];
      const changed: string[] = [];
      for (const { output, input: part } of answers) {
        const meeting = part.meetings[0];
        if (part.part !== 'prep' || !meeting) continue;
        const byRef = new Map(meeting.sources.map((each) => [each.ref, each.itemId]));
        const lines = (list: Output['open']) =>
          list.flatMap((raw) => toLine(raw, byRef, dropped) ?? []).slice(0, MAX_LINES);
        const detail: MeetingPrepDetail = {
          kind: 'meeting-prep',
          eventId: meeting.event.id,
          revision: meeting.revision,
          preparedAt: now(),
          about: output.about ? toLine(output.about, byRef, dropped) : null,
          lastTime: lines(output.lastTime),
          open: lines(output.open),
          raise: lines(output.raise),
        };
        // The event may have changed while Ares was thinking: prepared for as he read it.
        const event = eventOf(meeting.event.id) ?? meeting.event;
        const prepId = save(event, detail);
        changed.push(prepId, event.id);
        const { start, end } = event.detail;
        if (end.at > now()) {
          enqueue({
            group: 'now',
            mergeKey: `meeting-prep:${event.id}`,
            about: {
              kind: 'meeting-prep',
              eventId: event.id,
              prepId,
              title: event.title,
              startsAt: start.at,
            },
            itemIds: [event.id],
            section: 'calendar',
            importance: 0.9,
            expiresAt: end.at,
          });
        }
      }
      if (changed.length) onItemsChanged?.([...new Set(changed)]);
      return { dropped };
    },

    proposals(output, input) {
      const meeting = input.meetings[0];
      if (input.part !== 'asks' || !meeting) return { proposals: [], dropped: [] };
      const event = eventOf(meeting.event.id);
      if (!event || !isPrepWorthy(event))
        return { proposals: [], dropped: ['the meeting changed meanwhile'] };
      const dropped: string[] = [];
      const already = offered(event.id);
      const proposals: JobProposal[] = [];
      for (const raw of output.todos) {
        if (!raw) {
          dropped.push('a Todo that wasn’t one');
          continue;
        }
        const title = cleanTitle(raw.title);
        if (!title || raw.confidence < MIN_TODO_CONFIDENCE) continue;
        if (already.has(title.toLowerCase())) {
          dropped.push(`“${title}” was offered before`);
          continue;
        }
        already.add(title.toLowerCase());
        proposals.push({
          as: { action: SUGGEST_TODOS, actionKind: 'organise', section: 'calendar' },
          itemId: event.id,
          itemActions: [
            {
              type: 'create',
              item: {
                kind: 'todo',
                title,
                filing: inheritedFiling(event.filing),
                detail: {
                  kind: 'todo',
                  origin: 'ares',
                  dueOn: localDay(event.detail.start.at),
                  backedBy: null,
                },
              },
            },
            { type: 'link', from: { step: 0 }, linkType: 'made-from', to: event.id },
          ],
          confidence: raw.confidence,
          reason: `The invitation for “${oneLine(event.title)}” asks for it.`,
          causedBy: { itemId: event.id },
        });
      }
      return { proposals, dropped };
    },
  };
}
