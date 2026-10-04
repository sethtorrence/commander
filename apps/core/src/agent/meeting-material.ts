// What a meeting's prep rests on (#130), gathered by code, not the model, so what Ares reads is
// decided here and bounded:
//
// - The other people in it (its guests and organiser who aren't the User; rooms left out), by email
//   address, matched against Items' People handles (Person matching, M4, will widen this).
// - Their Items that are still open, of any kind: Linear issues now; PRs, emails and Teams Chats join
//   as those Sources' Items arrive, with no change here. Events and Commander's own notes aren't
//   among them.
// - The Items already Linked to the event (a Todo made from it, a Block mentioning it), but not its
//   meeting chip or Ares's own prep.
// - The notes under the chips of earlier meetings in the same series (the two latest with notes), or
//   else under the last meeting with the same people, from past Daily Notes.
// - Capped: the newest 40 Items, so the call stays small.
import {
  type EventAttendee,
  type EventDetail,
  type Item,
  isEvent,
  localDay,
  meetingChipEventId,
  otherAttendees,
} from '@commander/domain';
import type { ItemStore } from '../item-store';

type Event = Item & { detail: EventDetail };

export const MAX_ITEMS = 40;
// Earlier meetings are looked for this far back.
const LOOKBACK_MS = 90 * 24 * 60 * 60_000;
// At most this many earlier meetings of a series, and lines of notes from each.
const MAX_EARLIER = 2;
const MAX_NOTE_LINES = 40;
// Kinds that are never "an Item involving them": meetings themselves, and Commander's own notes and preps.
const NOT_INVOLVING = new Set<Item['kind']>(['event', 'daily-note', 'block', 'meeting-prep']);

export type EarlierMeeting = {
  event: Event;
  // Its meeting chip, and the day of the Daily Note it is in.
  chip: Item;
  day: string;
  // The notes under the chip, in outline order, each with how deep it sits under the chip.
  lines: { block: Item; text: string; depth: number }[];
};

export type MeetingMaterial = {
  event: Event;
  people: EventAttendee[];
  // Newest first, at most `cap`.
  items: Item[];
  // Newest first.
  earlier: EarlierMeeting[];
};

const textOf = (item: Item) => (item.detail?.kind === 'block' ? item.detail.text : '');
const isChipOf = (item: { kind: string; title: string }, eventId: string) =>
  item.kind === 'block' && meetingChipEventId(item.title) === eventId;
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((each) => b.includes(each));

export function gatherMeetingMaterial(
  store: ItemStore,
  event: Event,
  { cap = MAX_ITEMS }: { cap?: number } = {},
): MeetingMaterial {
  const people = otherAttendees(event.detail);
  const emails = people.map((person) => person.email.toLowerCase());

  // Their open Items, of any kind but the ones above.
  const involving = emails.length
    ? store
        .query({ people: emails, statuses: ['open'], limit: cap * 5 })
        .filter((item) => !NOT_INVOLVING.has(item.kind) && item.id !== event.id)
    : [];

  // The Items linked to the event, either way, but not its chip or a prep.
  const view = store.get(event.id);
  const linkedIds = new Set<string>();
  for (const link of [...(view?.links ?? []), ...(view?.backlinks ?? [])]) {
    const other = link.from.id === event.id ? link.to : link.from;
    if (other.kind === 'project' || other.kind === 'meeting-prep' || other.id === event.id) continue;
    if (other.deletedAt !== null || isChipOf(other, event.id)) continue;
    linkedIds.add(other.id);
  }
  const linked = linkedIds.size ? store.query({ ids: [...linkedIds], limit: 1000 }) : [];

  const byId = new Map<string, Item>();
  for (const item of [...involving, ...linked]) byId.set(item.id, item);
  const items = [...byId.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1))
    .slice(0, cap);

  return { event, people, items, earlier: earlierMeetings(store, event, emails) };
}

function earlierMeetings(store: ItemStore, event: Event, emails: string[]): EarlierMeeting[] {
  const start = event.detail.start.at;
  const before = store
    .events({ from: start - LOOKBACK_MS, to: start })
    .filter(
      (other): other is Event =>
        isEvent(other) && other.id !== event.id && !other.detail.allDay && other.detail.start.at < start,
    )
    .sort((a, b) => b.detail.start.at - a.detail.start.at);

  const { seriesId } = event.detail;
  if (seriesId) {
    const series = before.filter((other) => other.detail.seriesId === seriesId);
    const found: EarlierMeeting[] = [];
    for (const other of series) {
      const notes = notesOf(store, other);
      if (notes) found.push(notes);
      if (found.length >= MAX_EARLIER) break;
    }
    if (found.length) return found;
  }
  if (!emails.length) return [];
  for (const other of before) {
    const theirs = otherAttendees(other.detail).map((person) => person.email.toLowerCase());
    if (!sameSet(theirs, emails)) continue;
    const notes = notesOf(store, other);
    if (notes) return [notes];
  }
  return [];
}

// The notes under an event's meeting chip (the latest chip with any), or null when there are none.
function notesOf(store: ItemStore, event: Event): EarlierMeeting | null {
  const chips = store
    .backlinks({ targetType: 'item', id: event.id })
    .filter(
      (link) => link.type === 'refers-to' && link.from.deletedAt === null && isChipOf(link.from, event.id),
    )
    .map((link) => store.get(link.from.id)?.item)
    .filter((chip): chip is Item => chip?.detail?.kind === 'block');
  for (const chip of chips.reverse()) {
    if (chip.detail?.kind !== 'block') continue;
    const blocks = store.blocks([chip.detail.dailyNoteId]);
    const children = new Map<string, Item[]>();
    for (const block of blocks) {
      const parent = block.detail?.kind === 'block' ? block.detail.parentId : null;
      if (!parent) continue;
      children.set(parent, [...(children.get(parent) ?? []), block]);
    }
    const lines: EarlierMeeting['lines'] = [];
    const walk = (parentId: string, depth: number) => {
      for (const block of children.get(parentId) ?? []) {
        if (lines.length >= MAX_NOTE_LINES) return;
        const text = textOf(block).replace(/\s+/g, ' ').trim();
        if (text) lines.push({ block, text, depth });
        walk(block.id, depth + 1);
      }
    };
    walk(chip.id, 0);
    if (!lines.length) continue;
    const note = store.get(chip.detail.dailyNoteId)?.item;
    const day = note?.detail?.kind === 'daily-note' ? note.detail.day : localDay(event.detail.start.at);
    return { event, chip, day, lines };
  }
  return null;
}
