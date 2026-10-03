import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type ActionContext,
  type ActivityAction,
  type ActivityEntry,
  type ActivityQuery,
  type Actor,
  actionContext,
  activityQuery,
  type BlockDetail,
  type CausedBy,
  type DailyNotePage,
  type DailyNoteQuery,
  type DailyTemplate,
  dailyNoteQuery,
  type Item,
  type ItemAction,
  type ItemDetail,
  type ItemKind,
  type ItemQuery,
  type ItemRef,
  type ItemView,
  itemAction,
  itemQuery,
  type Link,
  type LinkType,
  type Project,
  type ProjectAction,
  type ProjectQuery,
  type SaveResult,
  type Source,
  type SourceBatch,
  sourceBatch,
} from '@commander/domain';
import Database from 'better-sqlite3';
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { z } from 'zod';
import { type AutonomyStore, openAutonomyStore } from './autonomy';
import { dailyTemplateIn, inCopyOrder } from './daily-template';
import { type ModelStore, openModelStore } from './models';
import { projectsIn } from './projects';
import {
  actorColumns,
  blockDetailOf,
  changesBetween,
  dailyNoteDetailOf,
  type ItemRow,
  type ItemState,
  itemColumns,
  linearIssueDetailOf,
  stateOf,
  todoDetailOf,
  toEntry,
  toItem,
} from './rows';
import * as schema from './schema';
import { type Snapshot, takeDailySnapshot } from './snapshots';
import { openSyncStateStore, type SyncStateStore } from './sync-state';

export type { NewProposal } from './autonomy';
export type { Snapshot } from './snapshots';
export type { SyncRun, SyncState, SyncStateStore } from './sync-state';

export type ItemStoreOptions = {
  // The SQLite database file. Created, and migrated to the latest schema, on open.
  path: string;
  // Where daily snapshots of the database are kept.
  snapshotDir: string;
  // The drizzle-kit migrations folder.
  migrationsFolder: string;
  // The clock, in epoch milliseconds. Injectable for tests.
  now?: () => number;
};

export type ItemStore = {
  saveFromSource(batch: SourceBatch): SaveResult;
  // Deletes every Item that came from one Account, when the User removes it. They stay as
  // tombstones, so Links from notes and Todos show them as gone. Returns their ids.
  removeAccountItems(account: { source: Source; account: string }, context: ActionContext): string[];
  query(query?: ItemQuery): Item[];
  // An Item with its Links and backlinks; tombstones included.
  get(itemId: string): ItemView | null;
  // Links two Items: shorthand for recording a link action.
  link(link: { from: string; linkType: LinkType; to: string }, context: ActionContext): ActivityEntry;
  // Every change made in Commander goes through here, and each one records an activity entry.
  record(action: ItemAction, context: ActionContext): ActivityEntry;
  // Records several actions in order, all or none: a refused action rolls back the ones before it.
  recordAll(actions: ItemAction[], context: ActionContext): ActivityEntry[];
  activity(query?: ActivityQuery): ActivityEntry[];
  // Projects in their order; archived ones only when asked for.
  projects(query?: ProjectQuery): Project[];
  // Creates (later also renames, reorders, archives) a Project. Not an Item change, so not logged.
  changeProject(action: ProjectAction): Project;
  // The Daily Note for a calendar day (YYYY-MM-DD), made (and recorded) if there isn't one yet. With
  // `fromTemplate` (the day is being made as today), a new one starts with copies of the daily
  // template's Blocks, made in the same transaction; a Daily Note that already exists never does.
  ensureDailyNote(day: string, context: ActionContext, options?: { fromTemplate?: boolean }): Item;
  // Daily Notes, newest first.
  dailyNotes(query?: DailyNoteQuery): DailyNotePage;
  // The live Blocks of these Daily Notes, each note's in position order.
  blocks(dailyNoteIds: string[]): Item[];
  // One activity entry, or null.
  entry(entryId: number): ActivityEntry | null;
  // Which of the given activity entries have been undone.
  undone(entryIds: number[]): number[];
  // Runs fn as one change: everything it records happens, or (when it throws) none of it does.
  transaction<T>(fn: () => T): T;
  // Settings → Notes → Daily template (the default until the User saves one). Not Items, so saving
  // it is not logged.
  dailyTemplate(): DailyTemplate;
  saveDailyTemplate(template: DailyTemplate): DailyTemplate;
  // Copies the database into the snapshot folder unless today's copy exists, keeping the last 7.
  takeDailySnapshot(): Snapshot | null;
  // The usage ledger and Settings → Ares, in the same database.
  models: ModelStore;
  // Where each Account's sync stands, and its recent sync runs, in the same database.
  syncState: SyncStateStore;
  // The Autonomy settings and the gate's proposals, in the same database.
  autonomy: AutonomyStore;
  close(): void;
};

export class ItemStoreError extends Error {
  constructor(
    readonly code: 'not-found' | 'invalid' | 'already-undone',
    message: string,
  ) {
    super(message);
    this.name = 'ItemStoreError';
  }
}

type LinkState = { from: string; linkType: LinkType; to: string };

function refOf(item: Item): ItemRef {
  return { id: item.id, kind: item.kind, title: item.title, source: item.source, deletedAt: item.deletedAt };
}

type NewEntry = {
  by: Actor;
  action: ActivityAction;
  itemId: string;
  otherItemId?: string | null;
  why?: string | null;
  causedBy?: CausedBy | null;
  undoes?: number | null;
  before: unknown;
  after: unknown;
};

// Daily Notes and Blocks only make sense with their detail: the day, or the place in the outline.
const NEEDS_DETAIL: ReadonlySet<ItemKind> = new Set(['daily-note', 'block']);

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

// A Daily Note's title: its day written out, "Saturday 3 October 2026".
function dayTitle(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${date} ${MONTHS[month - 1]} ${year}`;
}

const calendarDay = z.iso.date();

export function openItemStore(options: ItemStoreOptions): ItemStore {
  const now = options.now ?? Date.now;
  const sqlite = new Database(options.path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: options.migrationsFolder });
  const projects = projectsIn(db, now, (message) => new ItemStoreError('invalid', message));
  const template = dailyTemplateIn(db, now);

  function findBySourceIdentity(source: Source, account: string, externalId: string): Item | undefined {
    const { items } = schema;
    const row = db
      .select()
      .from(items)
      .where(and(eq(items.source, source), eq(items.account, account), eq(items.externalId, externalId)))
      .get();
    return row && withDetails([row])[0];
  }

  function readItem(id: string): Item | undefined {
    const row = db.select().from(schema.items).where(eq(schema.items.id, id)).get();
    return row && withDetails([row])[0];
  }

  function requireItem(id: string): Item {
    const item = readItem(id);
    if (!item) throw new ItemStoreError('not-found', `No Item ${id}`);
    return item;
  }

  function withDetails(rows: ItemRow[]): Item[] {
    const idsOf = (kind: ItemKind) => rows.filter((row) => row.kind === kind).map((row) => row.id);
    const details = new Map<string, ItemDetail>();
    const { todoDetails, dailyNoteDetails, blockDetails, linearIssueDetails } = schema;
    const todoIds = idsOf('todo');
    if (todoIds.length) {
      const found = db.select().from(todoDetails).where(inArray(todoDetails.itemId, todoIds)).all();
      for (const row of found) details.set(row.itemId, todoDetailOf(row));
    }
    const noteIds = idsOf('daily-note');
    if (noteIds.length) {
      const found = db.select().from(dailyNoteDetails).where(inArray(dailyNoteDetails.itemId, noteIds)).all();
      for (const row of found) details.set(row.itemId, dailyNoteDetailOf(row));
    }
    const blockIds = idsOf('block');
    if (blockIds.length) {
      const found = db.select().from(blockDetails).where(inArray(blockDetails.itemId, blockIds)).all();
      for (const row of found) details.set(row.itemId, blockDetailOf(row));
    }
    const issueIds = idsOf('linear-issue');
    if (issueIds.length) {
      const found = db
        .select()
        .from(linearIssueDetails)
        .where(inArray(linearIssueDetails.itemId, issueIds))
        .all();
      for (const row of found) details.set(row.itemId, linearIssueDetailOf(row));
    }
    return rows.map((row) => toItem(row, details.get(row.id) ?? null));
  }

  // Checks the state about to be written for an Item, and returns it as stored: a Block's title is its text.
  function checked(itemId: string, kind: ItemKind, state: ItemState): ItemState {
    if (state.detail && state.detail.kind !== kind) {
      throw new ItemStoreError('invalid', `A ${kind} Item cannot have ${state.detail.kind} detail`);
    }
    if (!state.detail && NEEDS_DETAIL.has(kind)) {
      throw new ItemStoreError('invalid', `A ${kind} Item needs its ${kind} detail`);
    }
    if (state.detail?.kind !== 'block') return state;
    checkBlockPlace(itemId, state.detail);
    return { ...state, title: state.detail.text };
  }

  // A Block sits in a Daily Note, at its top or under another Block of the same note, never under itself.
  function checkBlockPlace(itemId: string, block: BlockDetail) {
    if (readItem(block.dailyNoteId)?.kind !== 'daily-note') {
      throw new ItemStoreError(
        'invalid',
        `A Block belongs to a Daily Note, and ${block.dailyNoteId} is not one`,
      );
    }
    if (block.parentId === null) return;
    const { blockDetails } = schema;
    const placeOf = (id: string) => db.select().from(blockDetails).where(eq(blockDetails.itemId, id)).get();
    if (placeOf(block.parentId)?.dailyNoteId !== block.dailyNoteId) {
      throw new ItemStoreError('invalid', "A Block's parent must be a Block of the same Daily Note");
    }
    for (
      let ancestor: string | null = block.parentId;
      ancestor !== null;
      ancestor = placeOf(ancestor)?.parentId ?? null
    ) {
      if (ancestor === itemId) throw new ItemStoreError('invalid', 'A Block cannot be moved under itself');
    }
  }

  function writeDetail(id: string, detail: ItemDetail | null) {
    const { todoDetails, dailyNoteDetails, blockDetails, linearIssueDetails } = schema;
    if (detail?.kind !== 'todo') db.delete(todoDetails).where(eq(todoDetails.itemId, id)).run();
    if (detail?.kind !== 'daily-note')
      db.delete(dailyNoteDetails).where(eq(dailyNoteDetails.itemId, id)).run();
    if (detail?.kind !== 'block') db.delete(blockDetails).where(eq(blockDetails.itemId, id)).run();
    if (detail?.kind !== 'linear-issue')
      db.delete(linearIssueDetails).where(eq(linearIssueDetails.itemId, id)).run();
    switch (detail?.kind) {
      case 'todo': {
        const values = { origin: detail.origin, dueOn: detail.dueOn, backedBy: detail.backedBy };
        db.insert(todoDetails)
          .values({ itemId: id, ...values })
          .onConflictDoUpdate({ target: todoDetails.itemId, set: values })
          .run();
        return;
      }
      case 'daily-note': {
        const values = { day: detail.day };
        db.insert(dailyNoteDetails)
          .values({ itemId: id, ...values })
          .onConflictDoUpdate({ target: dailyNoteDetails.itemId, set: values })
          .run();
        return;
      }
      case 'linear-issue': {
        const { kind: _kind, ...data } = detail;
        const values = { identifier: detail.identifier, data };
        db.insert(linearIssueDetails)
          .values({ itemId: id, ...values })
          .onConflictDoUpdate({ target: linearIssueDetails.itemId, set: values })
          .run();
        return;
      }
      case 'block': {
        const { kind: _kind, ...values } = detail;
        db.insert(blockDetails)
          .values({ itemId: id, ...values })
          .onConflictDoUpdate({ target: blockDetails.itemId, set: values })
          .run();
        return;
      }
    }
  }

  // Inserts a new Item, under the caller's id if it chose one, and returns the id and the state as stored.
  function insertItem(
    identity: Pick<Item, 'kind' | 'source' | 'account' | 'externalId'>,
    input: ItemState,
    at: number,
    chosenId?: string,
  ): { id: string; state: ItemState } {
    if (chosenId && readItem(chosenId))
      throw new ItemStoreError('invalid', `The id ${chosenId} is already taken`);
    const id = chosenId ?? randomUUID();
    const state = checked(id, identity.kind, input);
    db.insert(schema.items)
      .values({ id, ...identity, ...itemColumns(state), createdAt: at, updatedAt: at })
      .run();
    writeDetail(id, state.detail);
    return { id, state };
  }

  // Writes an Item's new state and returns it as stored.
  function writeState(item: Item, input: ItemState, at: number): ItemState {
    const state = checked(item.id, item.kind, input);
    db.update(schema.items)
      .set({ ...itemColumns(state), updatedAt: at })
      .where(eq(schema.items.id, item.id))
      .run();
    writeDetail(item.id, state.detail);
    return state;
  }

  function log(entry: NewEntry, at: number): ActivityEntry {
    const row = db
      .insert(schema.activity)
      .values({
        at,
        ...actorColumns(entry.by),
        action: entry.action,
        itemId: entry.itemId,
        otherItemId: entry.otherItemId ?? null,
        why: entry.why ?? null,
        causedByItemId: entry.causedBy?.itemId ?? null,
        causedByEntryId: entry.causedBy?.entryId ?? null,
        undoes: entry.undoes ?? null,
        before: entry.before,
        after: entry.after,
      })
      .returning()
      .get();
    return toEntry(row);
  }

  function readLinks(where: 'from' | 'to', itemId: string): Link[] {
    const { links } = schema;
    const rows = db
      .select()
      .from(links)
      .where(eq(where === 'from' ? links.fromItemId : links.toItemId, itemId))
      .orderBy(links.id)
      .all();
    return rows.map((row) => ({
      type: row.type,
      from: refOf(requireItem(row.fromItemId)),
      to: refOf(requireItem(row.toItemId)),
      createdAt: row.createdAt,
    }));
  }

  function findLink({ from, linkType, to }: LinkState) {
    const { links } = schema;
    return db
      .select()
      .from(links)
      .where(and(eq(links.fromItemId, from), eq(links.type, linkType), eq(links.toItemId, to)))
      .get();
  }

  const record = sqlite.transaction((input: ItemAction, rawContext: ActionContext): ActivityEntry => {
    const action = itemAction.parse(input);
    const context = actionContext.parse(rawContext);
    const at = now();
    const entry = { by: context.by, why: context.why, causedBy: context.causedBy };
    switch (action.type) {
      case 'create': {
        const { id: chosenId, kind, ...fields } = action.item;
        projects.checkFiling(fields.filing);
        const identity = { kind, source: null, account: null, externalId: null };
        const { id, state } = insertItem(identity, { ...fields, deletedAt: null }, at, chosenId);
        return log({ ...entry, action: 'create', itemId: id, before: null, after: state }, at);
      }
      case 'update': {
        const item = requireItem(action.itemId);
        projects.checkFiling(action.changes.filing);
        const before = stateOf(item);
        const after = writeState(item, { ...before, ...action.changes }, at);
        return log({ ...entry, action: 'update', itemId: item.id, before, after }, at);
      }
      case 'delete': {
        const item = requireItem(action.itemId);
        const before = stateOf(item);
        const after: ItemState = { ...before, deletedAt: before.deletedAt ?? at };
        writeState(item, after, at);
        return log({ ...entry, action: 'delete', itemId: item.id, before, after }, at);
      }
      case 'link':
      case 'unlink': {
        const link: LinkState = { from: action.from, linkType: action.linkType, to: action.to };
        requireItem(link.from);
        requireItem(link.to);
        if (link.from === link.to) throw new ItemStoreError('invalid', 'An Item cannot link to itself');
        if (action.type === 'unlink' && !findLink(link)) {
          throw new ItemStoreError('not-found', `No ${link.linkType} Link from ${link.from} to ${link.to}`);
        }
        const existed = setLink(link, action.type === 'link', at);
        const after = action.type === 'link' ? link : null;
        return log(
          { ...entry, action: action.type, itemId: link.from, otherItemId: link.to, before: existed, after },
          at,
        );
      }
      case 'undo':
        return undo(action.entryId, entry, at);
    }
  });

  // Makes the Link present or absent, and returns it if it was present before.
  function setLink(link: LinkState, present: boolean, at: number): LinkState | null {
    const { links } = schema;
    const existing = findLink(link);
    if (present && !existing) {
      db.insert(links)
        .values({ fromItemId: link.from, type: link.linkType, toItemId: link.to, createdAt: at })
        .run();
    }
    if (!present && existing) db.delete(links).where(eq(links.id, existing.id)).run();
    return existing ? link : null;
  }

  // Restores what an activity entry changed: the Link's presence, or the Item fields it touched.
  function undo(
    entryId: number,
    entry: Pick<NewEntry, 'by' | 'why' | 'causedBy'>,
    at: number,
  ): ActivityEntry {
    const { activity } = schema;
    const target = db.select().from(activity).where(eq(activity.id, entryId)).get();
    if (!target) throw new ItemStoreError('not-found', `No activity entry ${entryId}`);
    if (db.select().from(activity).where(eq(activity.undoes, entryId)).get()) {
      throw new ItemStoreError('already-undone', `Activity entry ${entryId} is already undone`);
    }
    const undoEntry = { ...entry, action: 'undo' as const, itemId: target.itemId, undoes: entryId };

    if (target.otherItemId !== null) {
      const wanted = target.before as LinkState | null;
      const link = (target.before ?? target.after) as LinkState;
      const existed = setLink(link, wanted !== null, at);
      return log({ ...undoEntry, otherItemId: target.otherItemId, before: existed, after: wanted }, at);
    }

    const item = requireItem(target.itemId);
    const current = stateOf(item);
    const before = target.before as ItemState | null;
    const after = target.after as ItemState;
    // Undoing a creation deletes the Item; it stays as a tombstone so its history survives.
    let restored: ItemState = { ...current, deletedAt: at };
    if (before) {
      restored = { ...current };
      for (const change of changesBetween(before, after))
        Object.assign(restored, { [change.field]: change.before });
    }
    writeState(item, restored, at);
    return log({ ...undoEntry, before: current, after: restored }, at);
  }

  const recordAll = sqlite.transaction((actions: ItemAction[], context: ActionContext): ActivityEntry[] =>
    actions.map((action) => record(action, context)),
  );

  function findDailyNote(day: string): Item | undefined {
    const { items, dailyNoteDetails } = schema;
    const row = db
      .select({ item: items })
      .from(items)
      .innerJoin(dailyNoteDetails, eq(dailyNoteDetails.itemId, items.id))
      .where(eq(dailyNoteDetails.day, day))
      .get();
    return row && withDetails([row.item])[0];
  }

  // Fills a new Daily Note with copies of the template's Blocks: fresh ids, the same outline.
  function copyTemplate(dailyNoteId: string, entry: Pick<NewEntry, 'by' | 'causedBy'>, at: number) {
    const ids = new Map<string, string>();
    for (const block of inCopyOrder(template.read().blocks)) {
      const id = randomUUID();
      ids.set(block.id, id);
      const parentId = block.parentId === null ? null : (ids.get(block.parentId) ?? null);
      const { position, text, folded } = block;
      const copy: ItemState = {
        title: text,
        people: [],
        status: 'open',
        filing: null,
        detail: { kind: 'block', dailyNoteId, parentId, position, text, folded },
        deletedAt: null,
      };
      const identity = { kind: 'block' as const, source: null, account: null, externalId: null };
      const { state } = insertItem(identity, copy, at, id);
      log(
        {
          ...entry,
          why: 'From the daily template',
          action: 'create',
          itemId: id,
          before: null,
          after: state,
        },
        at,
      );
    }
  }

  const ensureDailyNote = sqlite.transaction((input: string, rawContext: ActionContext): Item => {
    const day = calendarDay.parse(input);
    const context = actionContext.parse(rawContext);
    const entry = { by: context.by, why: context.why, causedBy: context.causedBy };
    const existing = findDailyNote(day);
    if (existing && existing.deletedAt === null) return existing;
    const at = now();
    if (existing) {
      // A deleted Daily Note comes back rather than a second one being made for the same day.
      const before = stateOf(existing);
      const after = writeState(existing, { ...before, deletedAt: null }, at);
      log({ ...entry, action: 'update', itemId: existing.id, before, after }, at);
      return requireItem(existing.id);
    }
    const identity = { kind: 'daily-note' as const, source: null, account: null, externalId: null };
    const fresh: ItemState = {
      title: dayTitle(day),
      people: [],
      status: 'open',
      filing: null,
      detail: { kind: 'daily-note', day },
      deletedAt: null,
    };
    const { id, state } = insertItem(identity, fresh, at);
    log({ ...entry, action: 'create', itemId: id, before: null, after: state }, at);
    return requireItem(id);
  });

  // A Daily Note made as today: if there was none for the day at all, it starts with the template.
  const ensureFromTemplate = sqlite.transaction((input: string, rawContext: ActionContext): Item => {
    const isNew = !findDailyNote(calendarDay.parse(input));
    const note = ensureDailyNote(input, rawContext);
    if (isNew) copyTemplate(note.id, actionContext.parse(rawContext), now());
    return note;
  });

  function dailyNotes(input: DailyNoteQuery = {}): DailyNotePage {
    const query = dailyNoteQuery.parse(input);
    const { items, dailyNoteDetails } = schema;
    // Live Blocks of the Daily Note in the outer query, with text when `written`.
    const liveBlocks = (written: boolean) => sql`(
      SELECT count(*) FROM block_details b JOIN items bi ON bi.id = b.item_id
      WHERE b.daily_note_id = ${items.id} AND bi.deleted_at IS NULL${written ? sql` AND b.text <> ''` : sql``}
    )`;
    const filters = and(
      isNull(items.deletedAt),
      query.from ? gte(dailyNoteDetails.day, query.from) : undefined,
      query.to ? lte(dailyNoteDetails.day, query.to) : undefined,
      query.withContent ? sql`${liveBlocks(true)} > 0` : undefined,
      query.before ? lt(dailyNoteDetails.day, query.before) : undefined,
    );
    const rows = db
      .select({ item: items, day: dailyNoteDetails.day, blocks: sql<number>`${liveBlocks(false)}` })
      .from(items)
      .innerJoin(dailyNoteDetails, eq(dailyNoteDetails.itemId, items.id))
      .where(filters)
      .orderBy(desc(dailyNoteDetails.day))
      .limit(query.limit ?? 50)
      .all();
    const total =
      db
        .select({ total: sql<number>`count(*)` })
        .from(items)
        .innerJoin(dailyNoteDetails, eq(dailyNoteDetails.itemId, items.id))
        .where(filters)
        .get()?.total ?? 0;
    const withItems = withDetails(rows.map((row) => row.item));
    return {
      notes: rows.map((row, i) => ({ item: withItems[i] as Item, day: row.day, blocks: row.blocks })),
      total,
    };
  }

  function blocks(dailyNoteIds: string[]): Item[] {
    if (!dailyNoteIds.length) return [];
    const { items, blockDetails } = schema;
    const rows = db
      .select({ item: items })
      .from(items)
      .innerJoin(blockDetails, eq(blockDetails.itemId, items.id))
      .where(and(inArray(blockDetails.dailyNoteId, dailyNoteIds), isNull(items.deletedAt)))
      .orderBy(asc(blockDetails.dailyNoteId), asc(blockDetails.position), asc(items.id))
      .all();
    return withDetails(rows.map((row) => row.item));
  }

  const saveFromSource = sqlite.transaction((input: SourceBatch): SaveResult => {
    const batch = sourceBatch.parse(input);
    const by: Actor = { kind: 'source', source: batch.source, account: batch.account };
    const result: SaveResult = { created: [], updated: [], tombstoned: [], unchanged: [] };
    for (const incoming of batch.items) {
      const at = now();
      const existing = findBySourceIdentity(batch.source, batch.account, incoming.externalId);
      if (existing) {
        const before = stateOf(existing);
        const after: ItemState = {
          ...before,
          title: incoming.title,
          people: incoming.people,
          status: incoming.status,
          detail: incoming.detail,
          deletedAt: null,
        };
        if (isDeepStrictEqual(before, after)) {
          result.unchanged.push(existing.id);
          continue;
        }
        writeState(existing, after, at);
        log({ by, action: 'update', itemId: existing.id, before, after }, at);
        result.updated.push(existing.id);
        continue;
      }
      const state: ItemState = {
        title: incoming.title,
        people: incoming.people,
        status: incoming.status,
        filing: null,
        detail: incoming.detail,
        deletedAt: null,
      };
      const identity = {
        kind: incoming.kind,
        source: batch.source,
        account: batch.account,
        externalId: incoming.externalId,
      };
      const { id, state: stored } = insertItem(identity, state, at);
      log({ by, action: 'create', itemId: id, before: null, after: stored }, at);
      result.created.push(id);
    }
    for (const externalId of batch.deleted) {
      const existing = findBySourceIdentity(batch.source, batch.account, externalId);
      if (!existing || existing.deletedAt !== null) continue;
      const at = now();
      const before = stateOf(existing);
      const after: ItemState = { ...before, deletedAt: at };
      writeState(existing, after, at);
      log({ by, action: 'tombstone', itemId: existing.id, before, after }, at);
      result.tombstoned.push(existing.id);
    }
    return result;
  });

  const removeAccountItems = sqlite.transaction(
    ({ source, account }: { source: Source; account: string }, rawContext: ActionContext): string[] => {
      const context = actionContext.parse(rawContext);
      const { items } = schema;
      const rows = db
        .select()
        .from(items)
        .where(and(eq(items.source, source), eq(items.account, account), isNull(items.deletedAt)))
        .all();
      return withDetails(rows).map((item) => {
        const at = now();
        const before = stateOf(item);
        const after: ItemState = { ...before, deletedAt: at };
        writeState(item, after, at);
        log({ ...context, action: 'delete', itemId: item.id, before, after }, at);
        return item.id;
      });
    },
  );

  return {
    models: openModelStore(db, now),
    syncState: openSyncStateStore(db),
    autonomy: openAutonomyStore(db, now),

    saveFromSource,
    removeAccountItems,

    query(input = {}) {
      const query = itemQuery.parse(input);
      const { items } = schema;
      const rows = db
        .select()
        .from(items)
        .where(
          and(
            query.includeDeleted ? undefined : isNull(items.deletedAt),
            query.kinds ? inArray(items.kind, query.kinds) : undefined,
            query.projectId === null ? isNull(items.projectId) : undefined,
            query.projectId ? eq(items.projectId, query.projectId) : undefined,
            query.source ? eq(items.source, query.source) : undefined,
            query.account ? eq(items.account, query.account) : undefined,
            query.statuses ? inArray(items.status, query.statuses) : undefined,
            query.titleContains
              ? sql`${items.title} LIKE ${`%${query.titleContains.replace(/[\\%_]/g, '\\$&')}%`} ESCAPE '\\'`
              : undefined,
          ),
        )
        .orderBy(desc(items.updatedAt), desc(items.createdAt))
        .limit(query.limit ?? 200)
        .all();
      return withDetails(rows);
    },

    get(itemId) {
      const item = readItem(itemId);
      if (!item) return null;
      return { item, links: readLinks('from', itemId), backlinks: readLinks('to', itemId) };
    },

    link(link, context) {
      return record({ type: 'link', ...link }, context);
    },

    record,
    recordAll,
    ensureDailyNote: (day, context, options) =>
      options?.fromTemplate ? ensureFromTemplate(day, context) : ensureDailyNote(day, context),
    dailyNotes,
    blocks,
    dailyTemplate: () => template.read(),
    saveDailyTemplate: (input) => template.save(input),

    activity(input = {}) {
      const query = activityQuery.parse(input);
      const { activity } = schema;
      return db
        .select()
        .from(activity)
        .where(
          query.itemId
            ? or(eq(activity.itemId, query.itemId), eq(activity.otherItemId, query.itemId))
            : undefined,
        )
        .orderBy(desc(activity.id))
        .limit(query.limit ?? 200)
        .all()
        .map(toEntry);
    },

    projects: (query) => projects.list(query),

    changeProject: (action) => projects.change(action),

    entry(entryId) {
      const row = db.select().from(schema.activity).where(eq(schema.activity.id, entryId)).get();
      return row ? toEntry(row) : null;
    },

    undone(entryIds) {
      if (!entryIds.length) return [];
      const { activity } = schema;
      return db
        .select({ undoes: activity.undoes })
        .from(activity)
        .where(inArray(activity.undoes, entryIds))
        .all()
        .map((row) => row.undoes as number);
    },

    transaction<T>(fn: () => T): T {
      return sqlite.transaction(fn)();
    },

    takeDailySnapshot() {
      return takeDailySnapshot(sqlite, options.snapshotDir, now());
    },

    close() {
      sqlite.close();
    },
  };
}
