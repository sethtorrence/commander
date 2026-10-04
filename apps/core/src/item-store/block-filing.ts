// Block Projects (#51) in the Item store. A Block's Project is its own (the User's `#LT` or Badge
// picker, a Rule, Ares) or else its parent's, all the way up; a top-level Block with none is Unfiled.
// The effective Project is kept on every Block's Item, filed as inherited, so queries and the Project
// filter need no tree walk. A Todo made from a Block (a made-from Link) takes its Block's Project as
// inherited and follows it until the User files the Todo by hand. A meeting chip (a Block starting with
// a calendar event's `[[event:<id>]]`, #128) takes its event's Project instead of its parent's, and
// follows the event when it is re-filed, until the User files the chip itself.
//
// The Item store calls in here around each change it records: `settled` before writing, so a Block's
// (or a following Todo's) inherited Project is right in the change's own entry, and `afterUpdate` /
// `afterLink` after, which re-file the Blocks below and the Todos that follow. Each Item re-filed that
// way gets an activity entry of its own, by whoever made the change, caused by it, so its history says
// why it moved; undoing the change re-files them all again, so the change is still one step to undo.
import { isDeepStrictEqual } from 'node:util';
import {
  type ActivityEntry,
  type Actor,
  blockTag,
  type CausedBy,
  type Filing,
  type Item,
  type ItemKind,
  inheritedFiling,
  isOwnFiling,
  meetingChipEventId,
  type Project,
} from '@commander/domain';
import { and, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { type ItemRow, type ItemState, stateOf } from './rows';
import * as schema from './schema';

type Deps = {
  db: BetterSQLite3Database<typeof schema>;
  readItem(id: string): Item | undefined;
  withDetails(rows: ItemRow[]): Item[];
  writeState(item: Item, state: ItemState, at: number): ItemState;
  log(
    entry: {
      by: Actor;
      action: 'update';
      itemId: string;
      why: string;
      causedBy: CausedBy;
      before: ItemState;
      after: ItemState;
    },
    at: number,
  ): ActivityEntry;
  projects(): Project[];
};

export type BlockFiling = {
  // The state as it should be written: a Block without its own Project takes its parent's, and a
  // Todo following its Block takes the Block's.
  settled(itemId: string, kind: ItemKind, state: ItemState): ItemState;
  // After an Item changed: when a Block's Project or parent changed, re-files what follows it; when an
  // event's Project changed, its meeting chips (and what follows them).
  afterUpdate(item: Item, before: ItemState, entry: ActivityEntry, at: number): void;
  // After a Link appeared: a Todo made from a Block takes the Block's Project.
  afterLink(link: { from: string; linkType: string; to: string }, entry: ActivityEntry, at: number): void;
  // A daily template Block's own Project, from the `#LT` in its text.
  fromText(text: string): Filing;
};

export function blockFilingIn(deps: Deps): BlockFiling {
  const { db } = deps;

  const filingOf = (id: string | null): Filing => (id ? (deps.readItem(id)?.filing ?? null) : null);

  // The Project a Block takes when it has none of its own: a meeting chip its event's (when the event
  // has one), any other Block its parent's.
  function inheritedFor(detail: { parentId: string | null; text: string }): Filing {
    const eventId = meetingChipEventId(detail.text);
    const event = eventId ? deps.readItem(eventId) : undefined;
    const fromEvent = event?.kind === 'event' ? event.filing : null;
    return inheritedFiling(fromEvent ?? filingOf(detail.parentId));
  }

  // The live meeting chips of an event: Blocks linking to it that start with its token.
  function chipsOf(eventId: string): Item[] {
    const { links, items } = schema;
    const rows = db
      .select({ item: items })
      .from(links)
      .innerJoin(items, eq(items.id, links.fromItemId))
      .where(
        and(
          eq(links.toItemId, eventId),
          eq(links.type, 'refers-to'),
          eq(items.kind, 'block'),
          isNull(items.deletedAt),
        ),
      )
      .all();
    return deps
      .withDetails(rows.map((row) => row.item))
      .filter((block) => block.detail?.kind === 'block' && meetingChipEventId(block.detail.text) === eventId);
  }

  // The live Block a Todo was made from, if it was.
  function madeFromBlock(todoId: string): Item | undefined {
    const { links, items } = schema;
    const row = db
      .select({ item: items })
      .from(links)
      .innerJoin(items, eq(items.id, links.toItemId))
      .where(
        and(
          eq(links.fromItemId, todoId),
          eq(links.type, 'made-from'),
          eq(items.kind, 'block'),
          isNull(items.deletedAt),
        ),
      )
      .orderBy(links.id)
      .all()
      .at(-1);
    return row && deps.withDetails([row.item])[0];
  }

  // The live Todos made from a Block.
  function todosOf(blockId: string): Item[] {
    const { links, items } = schema;
    const rows = db
      .select({ item: items })
      .from(links)
      .innerJoin(items, eq(items.id, links.fromItemId))
      .where(
        and(
          eq(links.toItemId, blockId),
          eq(links.type, 'made-from'),
          eq(items.kind, 'todo'),
          isNull(items.deletedAt),
        ),
      )
      .all();
    return deps.withDetails(rows.map((row) => row.item));
  }

  // The live Blocks of a Daily Note, by their parent.
  function childrenIn(dailyNoteId: string): Map<string | null, Item[]> {
    const { items, blockDetails } = schema;
    const rows = db
      .select({ item: items })
      .from(items)
      .innerJoin(blockDetails, eq(blockDetails.itemId, items.id))
      .where(and(eq(blockDetails.dailyNoteId, dailyNoteId), isNull(items.deletedAt)))
      .orderBy(blockDetails.position, items.id)
      .all();
    const byParent = new Map<string | null, Item[]>();
    for (const item of deps.withDetails(rows.map((row) => row.item))) {
      const parentId = item.detail?.kind === 'block' ? item.detail.parentId : null;
      byParent.set(parentId, [...(byParent.get(parentId) ?? []), item]);
    }
    return byParent;
  }

  function refile(item: Item, filing: Filing, why: string, by: Actor, causedBy: CausedBy, at: number) {
    if (isDeepStrictEqual(item.filing, filing)) return;
    const before = stateOf(item);
    const after = deps.writeState(item, { ...before, filing }, at);
    deps.log({ by, action: 'update', itemId: item.id, why, causedBy, before, after }, at);
  }

  // A Todo follows its Block while it is filed as inherited, or while it is Unfiled along with the
  // Block. One the User filed by hand (or unfiled while its Block had a Project) stays put.
  const follows = (todo: Item, blockWas: Filing) =>
    todo.filing ? todo.filing.filedBy === 'inherited' : blockWas === null;

  function refileTodos(block: Item, was: Filing, now: Filing, entry: ActivityEntry, at: number) {
    for (const todo of todosOf(block.id)) {
      if (!follows(todo, was)) continue;
      refile(
        todo,
        inheritedFiling(now),
        'Follows its Block',
        entry.by,
        { entryId: entry.id, itemId: block.id },
        at,
      );
    }
  }

  // Re-files everything that follows a Block whose Project went from `was` to its current one: its
  // Todos, and the Blocks below it without their own Project (and theirs, all the way down).
  function cascade(block: Item, was: Filing, entry: ActivityEntry, at: number) {
    if (block.detail?.kind !== 'block') return;
    const children = childrenIn(block.detail.dailyNoteId);
    const walk = (parent: Item, parentWas: Filing) => {
      refileTodos(parent, parentWas, parent.filing, entry, at);
      for (const child of children.get(parent.id) ?? []) {
        const childWas = child.filing;
        const filing = isOwnFiling(childWas) ? childWas : inheritedFiling(parent.filing);
        const causedBy = { entryId: entry.id, itemId: parent.id };
        refile(child, filing, 'Follows its parent Block', entry.by, causedBy, at);
        walk({ ...child, filing }, childWas);
      }
    };
    walk(block, was);
  }

  return {
    settled(itemId, kind, state) {
      if (kind === 'block' && state.detail?.kind === 'block' && !isOwnFiling(state.filing)) {
        return { ...state, filing: inheritedFor(state.detail) };
      }
      if (kind === 'todo' && state.filing?.filedBy === 'inherited') {
        const block = madeFromBlock(itemId);
        if (block) return { ...state, filing: inheritedFiling(block.filing) };
      }
      return state;
    },

    afterUpdate(item, before, entry, at) {
      if (item.kind === 'event') {
        if (isDeepStrictEqual(before.filing, item.filing)) return;
        for (const chip of chipsOf(item.id)) {
          if (isOwnFiling(chip.filing) || chip.detail?.kind !== 'block') continue;
          const filing = inheritedFor(chip.detail);
          const causedBy = { entryId: entry.id, itemId: item.id };
          refile(chip, filing, 'Follows its meeting', entry.by, causedBy, at);
          cascade({ ...chip, filing }, chip.filing, entry, at);
        }
        return;
      }
      if (item.kind !== 'block' || item.detail?.kind !== 'block') return;
      const parentWas = before.detail?.kind === 'block' ? before.detail.parentId : null;
      if (isDeepStrictEqual(before.filing, item.filing) && parentWas === item.detail.parentId) return;
      cascade(item, before.filing, entry, at);
    },

    afterLink(link, entry, at) {
      if (link.linkType !== 'made-from') return;
      const todo = deps.readItem(link.from);
      const block = deps.readItem(link.to);
      if (todo?.kind !== 'todo' || block?.kind !== 'block' || block.deletedAt !== null) return;
      if (todo.filing && todo.filing.filedBy !== 'inherited') return;
      const causedBy = { entryId: entry.id, itemId: block.id };
      refile(todo, inheritedFiling(block.filing), 'Takes its Block’s Project', entry.by, causedBy, at);
    },

    fromText(text) {
      const tag = blockTag(text, deps.projects());
      return tag ? { projectId: tag.projectId, filedBy: 'user' } : null;
    },
  };
}
