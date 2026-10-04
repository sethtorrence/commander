// Meeting chips in the Item store (#128): today's Daily Note lists today's meetings as chips under its
// top-level Meetings Block, one per event, in time order, kept in step with the calendar.
//
// - A chip is a Block whose text is the event's `[[event:<id>]]` token, so it is drawn as the event's
//   live card, survives the Markdown copy, and its refers-to Link (made from the token, like every
//   `[[` link) puts "Mentioned in" on the event. It takes the event's Project (block-filing.ts).
// - Only today, only once: chips go into today's note only (it is never made here: it is made when
//   Notes opens), and the `meeting_chips` table remembers each event's chip there, so re-opening,
//   restarting and re-syncing add nothing, and a chip the User deleted stays deleted.
// - Live: an event added later gets a chip on the next fill; a moved one re-sorts. A cancelled or
//   declined event's chip, or one whose event moved to another day, goes only if nothing is written
//   under it; with notes under it, it stays (its card says what happened). Notes are never lost.
// - The chips are made, moved and removed by the event's Source, as the activity log records it.
import { randomUUID } from 'node:crypto';
import {
  type ActivityEntry,
  type Actor,
  type BlockDetail,
  blockLinkToken,
  chipWorthyOn,
  type Item,
  isEvent,
  isMeetingsBlockText,
  localDay,
  meetingChipEventId,
  meetingStatus,
} from '@commander/domain';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { generateKeyBetween } from 'fractional-indexing';
import { eventRows } from './calendars';
import type { ItemRow, ItemState } from './rows';
import * as schema from './schema';

type Entry = { by: Actor; why: string };

type Deps = {
  db: BetterSQLite3Database<typeof schema>;
  now(): number;
  readItem(id: string): Item | undefined;
  withDetails(rows: ItemRow[]): Item[];
  findDailyNote(day: string): Item | undefined;
  // Makes a Block (its Links follow its text), recording it.
  create(id: string, state: ItemState, entry: Entry): void;
  // Changes an Item, recording it.
  update(item: Item, changes: Partial<ItemState>, entry: Entry): ActivityEntry;
  // Deletes an Item, recording it.
  remove(item: Item, entry: Entry): void;
  transaction<T>(fn: () => T): T;
};

/** What a fill changed: today's Daily Note (null when there is none yet) and the Items it touched. */
export type MeetingChipsChange = { dailyNoteId: string | null; itemIds: string[] };

export type MeetingChips = {
  // Brings today's meeting chips in step with today's events.
  fill(): MeetingChipsChange;
};

const DAY_MS = 24 * 60 * 60_000;

const blockOf = (item: Item): BlockDetail | null => (item.detail?.kind === 'block' ? item.detail : null);
const byPosition = (a: Item, b: Item) => {
  const pa = blockOf(a)?.position ?? '';
  const pb = blockOf(b)?.position ?? '';
  return pa < pb ? -1 : pa > pb ? 1 : a.id < b.id ? -1 : 1;
};

// The local midnight a day starts at, and the next one.
function dayRange(day: string): { from: number; to: number } {
  const [year = 1970, month = 1, date = 1] = day.split('-').map(Number);
  const from = new Date(year, month - 1, date).getTime();
  return { from, to: new Date(year, month - 1, date + 1).getTime() || from + DAY_MS };
}

export function meetingChipsIn(deps: Deps): MeetingChips {
  const { db } = deps;

  function liveBlocksOf(dailyNoteId: string): Item[] {
    const { items, blockDetails } = schema;
    const rows = db
      .select({ item: items })
      .from(items)
      .innerJoin(blockDetails, eq(blockDetails.itemId, items.id))
      .where(and(eq(blockDetails.dailyNoteId, dailyNoteId), isNull(items.deletedAt)))
      .orderBy(asc(blockDetails.position), asc(items.id))
      .all();
    return deps.withDetails(rows.map((row) => row.item));
  }

  function fill(): MeetingChipsChange {
    const day = localDay(deps.now());
    const note = deps.findDailyNote(day);
    if (!note || note.deletedAt !== null) return { dailyNoteId: null, itemIds: [] };
    const changed = new Set<string>();
    const blocks = liveBlocksOf(note.id);
    const children = new Map<string | null, Item[]>();
    for (const block of blocks) {
      const parentId = blockOf(block)?.parentId ?? null;
      children.set(parentId, [...(children.get(parentId) ?? []), block]);
    }
    const meetings = (children.get(null) ?? []).find((block) =>
      isMeetingsBlockText(blockOf(block)?.text ?? ''),
    );
    if (!meetings) return { dailyNoteId: note.id, itemIds: [] };

    const { meetingChips } = schema;
    const records = new Map(
      db
        .select()
        .from(meetingChips)
        .where(eq(meetingChips.dailyNoteId, note.id))
        .all()
        .map((row) => [row.eventId, row]),
    );
    const remember = (eventId: string, blockId: string) => {
      db.insert(meetingChips)
        .values({ dailyNoteId: note.id, eventId, blockId, createdAt: deps.now() })
        .onConflictDoUpdate({
          target: [meetingChips.dailyNoteId, meetingChips.eventId],
          set: { blockId },
        })
        .run();
      records.set(eventId, { dailyNoteId: note.id, eventId, blockId, createdAt: deps.now() });
    };
    const forget = (eventId: string) => {
      db.delete(meetingChips)
        .where(and(eq(meetingChips.dailyNoteId, note.id), eq(meetingChips.eventId, eventId)))
        .run();
      records.delete(eventId);
    };
    const sourceOf = (event: Item): Actor =>
      event.source && event.account
        ? { kind: 'source', source: event.source, account: event.account }
        : { kind: 'user' };

    // Whether anything is written under a Block: text (or a Todo, an image) anywhere below it.
    const written = (blockId: string): boolean =>
      (children.get(blockId) ?? []).some(
        (child) => (blockOf(child)?.text.trim() ?? '') !== '' || written(child.id),
      );
    const removeWithEmptyChildren = (block: Item, entry: Entry) => {
      for (const child of children.get(block.id) ?? []) removeWithEmptyChildren(child, entry);
      deps.remove(block, entry);
      changed.add(block.id);
    };

    // 1. The chips already there: those whose meeting is off today go, unless notes are under them.
    const live = new Map(blocks.map((block) => [block.id, block]));
    for (const record of [...records.values()]) {
      const block = live.get(record.blockId);
      if (!block) continue;
      const event = deps.readItem(record.eventId);
      const status = meetingStatus(event, day);
      if (status.kind === 'on' || written(block.id)) continue;
      const why =
        status.kind === 'moved'
          ? 'The meeting moved to another day'
          : status.kind === 'declined'
            ? 'The meeting was declined'
            : 'The meeting was cancelled';
      removeWithEmptyChildren(block, { by: event ? sourceOf(event) : { kind: 'user' }, why });
      forget(record.eventId);
    }

    // 2. Today's meetings without a chip get one (a Block the User started with the event's link, under
    //    Meetings, counts as its chip).
    const { from, to } = dayRange(day);
    const events = deps
      .withDetails(eventRows(db, { from, to }))
      .filter((event) => chipWorthyOn(event, day))
      .sort((a, b) => startOf(a) - startOf(b) || (a.title < b.title ? -1 : 1));
    const under = () =>
      liveBlocksOf(note.id)
        .filter((block) => blockOf(block)?.parentId === meetings.id)
        .sort(byPosition);
    for (const event of events) {
      if (records.has(event.id)) continue;
      const siblings = under();
      const written = siblings.find((block) => meetingChipEventId(blockOf(block)?.text ?? '') === event.id);
      if (written) {
        remember(event.id, written.id);
        continue;
      }
      // After the last chip of a meeting starting no later, or before the first chip; at the end of
      // Meetings when it has none.
      const chips = siblings.filter((block) => chipEvent(block, records));
      const earlier = chips.filter((block) => startOf(chipEvent(block, records)) <= startOf(event)).at(-1);
      const later = chips.find((block) => startOf(chipEvent(block, records)) > startOf(event));
      let before: Item | undefined;
      let after: Item | undefined;
      if (earlier) {
        before = earlier;
        after = siblings[siblings.indexOf(earlier) + 1];
      } else if (later) {
        after = later;
        before = siblings[siblings.indexOf(later) - 1];
      } else before = siblings.at(-1);
      const position = between(before, after);
      const id = randomUUID();
      const text = blockLinkToken({ type: 'event', eventId: event.id });
      deps.create(
        id,
        {
          title: text,
          people: [],
          status: 'open',
          filing: null,
          detail: {
            kind: 'block',
            dailyNoteId: note.id,
            parentId: meetings.id,
            position,
            text,
            folded: false,
          },
          deletedAt: null,
        },
        { by: sourceOf(event), why: 'Today’s meeting from the calendar' },
      );
      remember(event.id, id);
      changed.add(id);
    }

    // 3. The chips of today's meetings under Meetings keep time order, among the places they hold.
    const siblings = under();
    const chips = siblings.filter((block) => {
      const event = chipEvent(block, records);
      return event && meetingStatus(event, day).kind === 'on';
    });
    const slots = chips.map((block) => blockOf(block)?.position ?? '');
    const sorted = [...chips].sort((a, b) => {
      const ea = chipEvent(a, records);
      const eb = chipEvent(b, records);
      return startOf(ea) - startOf(eb) || byPosition(a, b);
    });
    sorted.forEach((block, index) => {
      const detail = blockOf(block);
      const position = slots[index];
      if (!detail || position === undefined || detail.position === position) return;
      const event = chipEvent(block, records);
      deps.update(
        block,
        { detail: { ...detail, position } },
        { by: event ? sourceOf(event) : { kind: 'user' }, why: 'The meeting moved' },
      );
      changed.add(block.id);
    });

    return { dailyNoteId: note.id, itemIds: [...changed] };
  }

  // The meeting a Block is the chip of, by the table.
  function chipEvent(block: Item, records: ReadonlyMap<string, { blockId: string }>): Item | undefined {
    for (const [eventId, record] of records) if (record.blockId === block.id) return deps.readItem(eventId);
    return undefined;
  }

  return { fill: () => deps.transaction(fill) };
}

const startOf = (item: Item | undefined) => (isEvent(item) ? item.detail.start.at : Number.POSITIVE_INFINITY);

// A position between two siblings (either may be missing).
function between(before: Item | undefined, after: Item | undefined): string {
  const a = before ? (blockOf(before)?.position ?? null) : null;
  const b = after ? (blockOf(after)?.position ?? null) : null;
  if (a !== null && b !== null && a >= b) return generateKeyBetween(a, null);
  return generateKeyBetween(a, b);
}
