import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
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
  type BlockIssue,
  type BlockTodo,
  type BlockTodoQuery,
  blockLinksIn,
  blockTodoQuery,
  type CausedBy,
  compactForLog,
  type DailyNotePage,
  type DailyNoteProjects,
  type DailyNoteQuery,
  type DailyTemplate,
  DELETE_FIELD,
  dailyNoteQuery,
  describeRule,
  type FieldSummary,
  type Filing,
  firstMatch,
  type Item,
  type ItemAction,
  type ItemDetail,
  type ItemKind,
  type ItemQuery,
  type ItemRef,
  type ItemView,
  itemAction,
  itemQuery,
  type LinearCatalog,
  type LinearIssueDraft,
  type LinearSendPrefill,
  type Link,
  type LinkEnd,
  type LinkTarget,
  type LinkTargetType,
  type LinkType,
  linearCatalog,
  type Mention,
  type MentionQuery,
  mentionQuery,
  type Project,
  type ProjectAction,
  type ProjectBlock,
  type ProjectChange,
  type ProjectQuery,
  type ProjectRef,
  type RefileCandidate,
  type Rule,
  type RuleAction,
  type RuleChange,
  type RulePreview,
  type RulePreviewRequest,
  ruleMatches,
  rulePreviewRequest,
  type SaveResult,
  type Source,
  type SourceBatch,
  sourceBatch,
  statusFromDetail,
} from '@commander/domain';
import Database from 'better-sqlite3';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { alias } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { openSearch, type Search } from '../search';
import { type AgentStore, openAgentStore } from './agent-jobs';
import { attachmentFolder } from './attachments';
import { type AutonomyStore, openAutonomyStore } from './autonomy';
import { blockFilingIn } from './block-filing';
import { dailyTemplateIn, inCopyOrder } from './daily-template';
import { type DashboardStore, openDashboardStore } from './dashboard';
import { type InjectionWarningStore, injectionWarningsIn } from './injection-warnings';
import { linearSendIn } from './linear-send';
import { linearTodosIn } from './linear-todos';
import { type MarkdownCopyFolderStore, markdownCopyFolderIn } from './markdown-copy-folder';
import { type ModelStore, openModelStore } from './models';
import { type OutgoingStore, openOutgoingQueue } from './outgoing';
import { projectsIn } from './projects';
import {
  actorColumns,
  blockDetailOf,
  changesBetween,
  chatDetailOf,
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
import { type ListChange, rulesIn } from './rules';
import * as schema from './schema';
import { keptSnapshots, type Snapshot, takeDailySnapshot } from './snapshots';
import { openSyncStateStore, type SyncStateStore } from './sync-state';
import { editedState, queueChanges, undoneDetail, withQueuedOnTop } from './synced-changes';
import { openUpdateStore, type UpdateStore } from './updates';

export type { Search } from '../search';
export type { AgentStore, JobState, SeenItem } from './agent-jobs';
export type { NewProposal } from './autonomy';
export type { DashboardStore, StoredClear } from './dashboard';
export type { InjectionWarningStore } from './injection-warnings';
export type { OutgoingRow, OutgoingStore } from './outgoing';
export type { Snapshot } from './snapshots';
export type { SyncRun, SyncState, SyncStateStore } from './sync-state';
export type { UpdateState, UpdateStore } from './updates';

export type ItemStoreOptions = {
  // The SQLite database file. Created, and migrated to the latest schema, on open.
  path: string;
  // Where daily snapshots of the database are kept.
  snapshotDir: string;
  // Where pasted images are kept; `attachments/` next to the database unless given.
  attachmentsDir?: string;
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
  // Links two Items (or an Item to a Project, for refers-to): shorthand for recording a link action.
  link(
    link: { from: string; linkType: LinkType; to: string; targetType?: LinkTargetType },
    context: ActionContext,
  ): ActivityEntry;
  // The one backlinks query: every Link pointing at an Item or a Project, oldest first. A Project's
  // include those to Projects merged into it.
  backlinks(target: LinkTarget): Link[];
  // Live Blocks whose `[[` links point at these targets, each with its day: newest day first, then
  // in outline order, target by target.
  mentions(query: MentionQuery): Mention[];
  // Every change made in Commander goes through here, and each one records an activity entry.
  record(action: ItemAction, context: ActionContext): ActivityEntry;
  // Send to Linear (linear-send.ts): makes a new Linear issue's Item, from a Todo, a Block or nothing,
  // and queues its creation for Linear, all as one change. Returns every entry it recorded, in order,
  // the issue's creation first; undoing them all, last first, undoes the send (deleting the issue in
  // Linear once it is there).
  sendToLinear(draft: LinearIssueDraft, context: ActionContext): ActivityEntry[];
  // Where the Send to Linear dialog starts for a Todo or Block, or (from the Linear Section) a Project.
  linearSendPrefill(request: { from?: string; projectId?: string | null }): LinearSendPrefill;
  // Records several actions in order, all or none: a refused action rolls back the ones before it.
  recordAll(actions: ItemAction[], context: ActionContext): ActivityEntry[];
  activity(query?: ActivityQuery): ActivityEntry[];
  // Projects in their order; archived ones only when asked for.
  projects(query?: ProjectQuery): Project[];
  // Creates, renames, recolours, reorders, archives, merges a Project, or undoes such a change. Kept
  // in the Project log, not the activity log, except for the Items a merge moves (one entry each).
  changeProject(action: ProjectAction): ProjectChange;
  // The Rules in their order: the first that matches an Item files it. Whenever Items are saved from
  // a Source, each one not filed by the User goes to its first matching Rule's Project (a Rule wins
  // over Ares and over inheritance); no match leaves its filing alone.
  rules(): Rule[];
  // Creates, edits, moves, deletes or restores a Rule. Also answers which existing Items the changed
  // list now files elsewhere (never hand-filed ones), for the User to re-file or not.
  changeRule(action: RuleAction): RuleChange;
  // How many Items a Rule as drafted matches, a sample of them, and the Rules it overlaps.
  previewRule(request: RulePreviewRequest): RulePreview;
  // Re-files these Items by the Rules, as one change: one activity entry each, with the Rule that
  // matched as the actor. Skips any the Rules no longer move (filed by hand since, say).
  refile(itemIds: string[]): ActivityEntry[];
  // Undoes a re-filing, all at once, by the User. Skips Items filed elsewhere since.
  undoRefile(entryIds: number[]): ActivityEntry[];
  // The Daily Note for a calendar day (YYYY-MM-DD), made (and recorded) if there isn't one yet. With
  // `fromTemplate` (the day is being made as today), a new one starts with copies of the daily
  // template's Blocks, made in the same transaction. One that already exists does only if it has
  // never held a Block (made ahead of time as a `[[day]]` link's target).
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
  // Live Todos made from live Blocks (a made-from Link to the Block), with the Block and its day.
  blockTodos(query: BlockTodoQuery): BlockTodo[];
  // Live Linear issues sent from live Blocks of these Daily Notes (a made-from Link to the Block), in
  // the order they were sent.
  blockIssues(dailyNoteIds: string[]): BlockIssue[];
  // Each Daily Note with written Blocks, newest first: the Projects they are filed under, and whether
  // any is Unfiled (the Project filter's counts in Notes).
  dailyNoteProjects(): DailyNoteProjects[];
  // A Project's written Blocks (own or inherited), newest day first, each day's in outline order.
  projectBlocks(projectId: string): ProjectBlock[];
  // The external ids of an Account's live Items behind open Todos (the issues of open Linear Todos):
  // each sync re-reads them, as what a Source reports changed can miss them (a reassignment).
  recheckIds(account: { source: Source; account: string }): string[];
  // The Account's live Items with these external ids, as last saved: for adapters that fetch only
  // part of an Item when it changes (a Chat's new messages).
  fromSource(account: { source: Source; account: string }, externalIds: string[]): Item[];
  // Copies the database into the snapshot folder unless today's copy exists, keeping the last 7,
  // with the pasted images they use (attachments.ts).
  takeDailySnapshot(): Snapshot | null;
  // Saves a pasted image into attachments/ and returns its file name (attachments.ts).
  saveAttachment(bytes: Uint8Array): { name: string };
  // The usage ledger and Settings → Ares, in the same database.
  models: ModelStore;
  // Where each Account's sync stands, and its recent sync runs, in the same database.
  syncState: SyncStateStore;
  // Two-way sync's outgoing queue: changes made in Commander to Source Items' synced fields, queued
  // by record (in the change's own transaction) and sent by the sync engine.
  outgoing: OutgoingStore;
  // The Autonomy settings and the gate's proposals, in the same database.
  autonomy: AutonomyStore;
  // Where Ares's jobs stand and what they have looked at, in the same database.
  agent: AgentStore;
  // The Dashboard (dashboard.ts): Ares's latest ranking and the cleared rows, in the same database.
  dashboard: DashboardStore;
  // Steering warnings (injection-warnings.ts): outside Items checked as they are saved from their
  // Source, and marked when they hold instructions aimed at Ares; a job's steering flag marks one too.
  injectionWarnings: InjectionWarningStore;
  // Global search over the live Items, kept current by every write here.
  search: Search;
  // A Project as a Link (or a `[[` link token) shows it: the one it was merged into, if it was. Null
  // for no such Project.
  projectRef(projectId: string): ProjectRef | null;
  // Settings → Notes → Markdown copy folder (markdown-copy-folder.ts), in the same database.
  markdownCopyFolder: MarkdownCopyFolderStore;
  // Ares's queue for the Update, the Updates he gave, and where the producers stand (updates.ts).
  updates: UpdateStore;
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

// A Link as the activity log records it. `targetType` is there only for a Link to a Project.
type LinkState = { from: string; linkType: LinkType; to: string; targetType?: 'project' };

const isProjectLink = (link: LinkState) => link.targetType === 'project';

function refOf(item: Item): ItemRef {
  return { id: item.id, kind: item.kind, title: item.title, source: item.source, deletedAt: item.deletedAt };
}

type NewEntry = {
  by: Actor;
  action: ActivityAction;
  itemId: string;
  otherItemId?: string | null;
  otherProjectId?: string | null;
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
  const template = dailyTemplateIn(db, now);
  const outgoing = openOutgoingQueue(db);
  const syncState = openSyncStateStore(db);
  const warnings = injectionWarningsIn(db, {
    now,
    readItem: (itemId) => readItem(itemId),
    record: ({ itemId, why, causedBy, after }, at) =>
      log(
        { by: { kind: 'ares' }, action: 'injection-warning', itemId, why, causedBy, before: null, after },
        at,
      ),
    toEntry,
  });
  // Project changes come only from the User (the window); a merge's Item moves are recorded as theirs.
  const byUser: Actor = { kind: 'user' };
  const projects = projectsIn(
    db,
    now,
    (message) => new ItemStoreError('invalid', message),
    {
      refile(from, into, why) {
        const rows = db.select().from(schema.items).where(eq(schema.items.projectId, from)).all();
        return withDetails(rows).map((item) => {
          const at = now();
          const before = stateOf(item);
          const filedBy = before.filing?.filedBy ?? 'user';
          const after = writeState(item, { ...before, filing: { projectId: into, filedBy } }, at);
          return log({ by: byUser, action: 'update', itemId: item.id, why, before, after }, at).id;
        });
      },
      undo: (entryIds, why) => undoFilings(entryIds, why).map((entry) => entry.id),
    },
    { retarget: (from, into) => rules.retarget(from, into), reverse: (moves) => rules.reverse(moves) },
  );
  const rules = rulesIn(
    db,
    now,
    (message) => new ItemStoreError('invalid', message),
    (projectId) => projects.checkFiling({ projectId, filedBy: 'rule' }),
  );
  const attachments = attachmentFolder({
    dir: options.attachmentsDir ?? join(dirname(options.path), 'attachments'),
    now,
    invalid: (message) => new ItemStoreError('invalid', message),
  });

  // Undoes entries that filed Items (a merge, or only a Rule's when `byRule`), as the User, skipping
  // any already undone and any Item filed elsewhere since.
  function undoFilings(entryIds: readonly number[], why: string, byRule = false): ActivityEntry[] {
    const { activity } = schema;
    const undone: ActivityEntry[] = [];
    for (const entryId of entryIds) {
      const target = db.select().from(activity).where(eq(activity.id, entryId)).get();
      if (!target || (byRule && target.actor !== 'rule')) continue;
      if (db.select().from(activity).where(eq(activity.undoes, entryId)).get()) continue;
      const item = readItem(target.itemId);
      const moved = (target.after as ItemState | null)?.filing;
      if (!item || !isDeepStrictEqual(item.filing, moved)) continue;
      undone.push(undo(entryId, { by: byUser, why }, now()));
    }
    return undone;
  }

  // The live Items from Sources: the ones Rules file.
  function sourceItems(): Item[] {
    const { items } = schema;
    const rows = db
      .select()
      .from(items)
      .where(and(isNotNull(items.source), isNull(items.deletedAt)))
      .orderBy(desc(items.updatedAt), desc(items.createdAt))
      .all();
    return withDetails(rows);
  }

  // Where the Rules file an Item, when that differs from where it is: never for an Item the User
  // filed by hand, and not when no Rule matches.
  function ruleFiling(item: Item, list: readonly Rule[]): { rule: Rule; filing: Filing } | null {
    if (item.filing?.filedBy === 'user') return null;
    const rule = firstMatch(list, item);
    if (!rule) return null;
    const filing: Filing = { projectId: rule.target.projectId, filedBy: 'rule' };
    // An Item already in the Rule's Project by inheritance (an issue sent to Linear takes its item's
    // Project) stays filed as it is.
    if (item.filing?.filedBy === 'inherited' && item.filing.projectId === filing.projectId) return null;
    return isDeepStrictEqual(item.filing, filing) ? null : { rule, filing };
  }

  function fileByRule(item: Item, { rule, filing }: { rule: Rule; filing: Filing }, at: number) {
    const before = stateOf(item);
    const after = writeState(item, { ...before, filing }, at);
    const why = `Rule: ${describeRule(rule.when)}`;
    return log(
      { by: { kind: 'rule', ruleId: rule.id }, action: 'update', itemId: item.id, why, before, after },
      at,
    );
  }

  // The existing Items a change to the list moves: those whose first matching Rule (or its Project)
  // differs from before, and which it files somewhere other than where they are.
  function refileCandidates({ before, after }: Pick<ListChange, 'before' | 'after'>): RefileCandidate[] {
    const candidates: RefileCandidate[] = [];
    for (const item of sourceItems()) {
      if (item.filing?.filedBy === 'user') continue;
      const match = firstMatch(after, item);
      if (!match || item.filing?.projectId === match.target.projectId) continue;
      const was = firstMatch(before, item);
      if (was?.id === match.id && was.target.projectId === match.target.projectId) continue;
      candidates.push({
        item: refOf(item),
        from: item.filing,
        to: { projectId: match.target.projectId, filedBy: 'rule' },
        ruleId: match.id,
      });
    }
    return candidates;
  }
  // Block Projects: a Block's inherited Project, and the Todos that follow their Blocks.
  const blockFiling = blockFilingIn({
    db,
    readItem,
    withDetails,
    writeState,
    log,
    projects: () => projects.list(),
  });

  // The search index follows every Item written below (insertItem and writeState).
  const search = openSearch(sqlite, {
    *allItems() {
      const { items } = schema;
      for (let after = ''; ; ) {
        const rows = db
          .select()
          .from(items)
          .where(and(isNull(items.deletedAt), sql`${items.id} > ${after}`))
          .orderBy(asc(items.id))
          .limit(500)
          .all();
        if (!rows.length) return;
        yield withDetails(rows);
        after = rows.at(-1)?.id ?? '';
      }
    },
    load(itemIds) {
      if (!itemIds.length) return [];
      return withDetails(db.select().from(schema.items).where(inArray(schema.items.id, itemIds)).all());
    },
    projects: () => projects.list(),
  });

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
    const { todoDetails, dailyNoteDetails, blockDetails, linearIssueDetails, chatDetails } = schema;
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
    const chatIds = idsOf('chat');
    if (chatIds.length) {
      const found = db.select().from(chatDetails).where(inArray(chatDetails.itemId, chatIds)).all();
      for (const row of found) details.set(row.itemId, chatDetailOf(row));
    }
    // The warning mark: an Item's own, or (for a Todo) the Item's behind it.
    const backedBy = (id: string) => {
      const detail = details.get(id);
      return detail?.kind === 'todo' ? detail.backedBy : null;
    };
    const marked = warnings.marked(
      rows.flatMap((row) => {
        const behind = backedBy(row.id);
        return behind ? [row.id, behind] : [row.id];
      }),
    );
    return rows.map((row) => {
      const item = toItem(row, details.get(row.id) ?? null);
      const at = marked.get(row.id) ?? marked.get(backedBy(row.id) ?? '');
      return at === undefined ? item : { ...item, injectionWarning: { at } };
    });
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
    const { todoDetails, dailyNoteDetails, blockDetails, linearIssueDetails, chatDetails } = schema;
    if (detail?.kind !== 'chat') db.delete(chatDetails).where(eq(chatDetails.itemId, id)).run();
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
      case 'chat': {
        const { kind: _kind, ...data } = detail;
        db.insert(chatDetails)
          .values({ itemId: id, data })
          .onConflictDoUpdate({ target: chatDetails.itemId, set: { data } })
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
    const state = checked(id, identity.kind, blockFiling.settled(id, identity.kind, input));
    db.insert(schema.items)
      .values({ id, ...identity, ...itemColumns(state), createdAt: at, updatedAt: at })
      .run();
    writeDetail(id, state.detail);
    search.put({ id, kind: identity.kind, account: identity.account, updatedAt: at, ...state });
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
    search.put({ id: item.id, kind: item.kind, account: item.account, updatedAt: at, ...state });
    return state;
  }

  function log(entry: NewEntry, at: number): ActivityEntry {
    const { before, after, summary } = forTheLog(entry);
    const row = db
      .insert(schema.activity)
      .values({
        at,
        ...actorColumns(entry.by),
        action: entry.action,
        itemId: entry.itemId,
        otherItemId: entry.otherItemId ?? null,
        otherProjectId: entry.otherProjectId ?? null,
        why: entry.why ?? null,
        causedByItemId: entry.causedBy?.itemId ?? null,
        causedByEntryId: entry.causedBy?.entryId ?? null,
        undoes: entry.undoes ?? null,
        before,
        after,
        summary,
      })
      .returning()
      .get();
    return toEntry(row);
  }

  // What the log keeps of an entry: a Source's changes to an Item have the detail fields the log
  // keeps only in summary (a Chat's messages) emptied, and summarised (the domain's logged-fields.ts).
  function forTheLog(entry: NewEntry): { before: unknown; after: unknown; summary: FieldSummary[] | null } {
    const isState = (state: unknown): state is ItemState =>
      typeof state === 'object' && state !== null && 'detail' in state;
    const { before, after } = entry;
    const itemEntry = !entry.otherItemId && !entry.otherProjectId;
    if (
      entry.by.kind !== 'source' ||
      !itemEntry ||
      !isState(after) ||
      (before !== null && !isState(before))
    ) {
      return { before, after, summary: null };
    }
    const compact = compactForLog(before?.detail ?? null, after.detail);
    if (compact.summaries.length === 0) return { before, after, summary: null };
    return {
      before: before && { ...before, detail: compact.before },
      after: { ...after, detail: compact.after },
      summary: compact.summaries,
    };
  }

  // A Project as the far end of a Link: the one it was merged into, if it was.
  function projectRefOf(projectId: string): ProjectRef {
    const { projects } = schema;
    let row = db.select().from(projects).where(eq(projects.id, projectId)).get();
    for (let hops = 0; row?.mergedInto && hops < 100; hops++) {
      const into: string = row.mergedInto;
      row = db.select().from(projects).where(eq(projects.id, into)).get();
    }
    if (!row) throw new ItemStoreError('not-found', `No Project ${projectId}`);
    const { id, name, code, accent, archived } = row;
    return { kind: 'project', id, title: name, code, accent, archived };
  }

  // The Project and every Project merged into it, however many merges back.
  function projectAndMerged(projectId: string): string[] {
    const { projects } = schema;
    const ids = [projectId];
    for (let i = 0; i < ids.length; i++) {
      const merged = db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.mergedInto, ids[i] as string))
        .all();
      for (const { id } of merged) if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  function toLink(row: typeof schema.links.$inferSelect): Link {
    const to: LinkEnd =
      row.targetType === 'project'
        ? projectRefOf(row.toProjectId as string)
        : refOf(requireItem(row.toItemId as string));
    return { type: row.type, from: refOf(requireItem(row.fromItemId)), to, createdAt: row.createdAt };
  }

  function linksFrom(itemId: string): Link[] {
    const { links } = schema;
    return db.select().from(links).where(eq(links.fromItemId, itemId)).orderBy(links.id).all().map(toLink);
  }

  function backlinks(target: LinkTarget): Link[] {
    const { links } = schema;
    const pointsAt =
      target.targetType === 'project'
        ? and(eq(links.targetType, 'project'), inArray(links.toProjectId, projectAndMerged(target.id)))
        : and(eq(links.targetType, 'item'), eq(links.toItemId, target.id));
    return db.select().from(links).where(pointsAt).orderBy(links.id).all().map(toLink);
  }

  function findLink(link: LinkState) {
    const { links } = schema;
    const to = isProjectLink(link)
      ? and(eq(links.targetType, 'project'), eq(links.toProjectId, link.to))
      : and(eq(links.targetType, 'item'), eq(links.toItemId, link.to));
    return db
      .select()
      .from(links)
      .where(and(eq(links.fromItemId, link.from), eq(links.type, link.linkType), to))
      .get();
  }

  // The activity entry columns naming a Link's far end.
  const otherEndOf = (link: LinkState) =>
    isProjectLink(link) ? { otherProjectId: link.to } : { otherItemId: link.to };

  // Makes a Link present (link) or absent (unlink), and records it in the activity log.
  function recordLink(
    link: LinkState,
    present: boolean,
    entry: Pick<NewEntry, 'by' | 'why' | 'causedBy'>,
    at: number,
  ): ActivityEntry {
    const existed = setLink(link, present, at);
    const action = present ? 'link' : 'unlink';
    const after = present ? link : null;
    const logged = log(
      { ...entry, action, itemId: link.from, ...otherEndOf(link), before: existed, after },
      at,
    );
    if (after) blockFiling.afterLink(after, logged, at);
    return logged;
  }

  /*
    Keeps a Block's `[[` links in step with its text (ADR 0002): a refers-to Link for each day or
    Project token in it, and none for a token no longer there. A day's token makes that day's Daily
    Note if it has none yet. It runs whenever a Block's text is written, by anyone, so undo, redo and
    moves need nothing of their own. Other refers-to Links from the Block (to other kinds of Item) are
    left alone.
  */
  function syncBlockLinks(
    blockId: string,
    text: string,
    entry: Pick<NewEntry, 'by' | 'causedBy'>,
    at: number,
  ) {
    const { links, items } = schema;
    const why = 'A [[ link in the Block';
    const wanted = new Map<string, LinkState>();
    for (const { target } of blockLinksIn(text)) {
      if (target.type === 'project') {
        if (!projects.exists(target.projectId)) continue;
        wanted.set(`project:${target.projectId}`, {
          from: blockId,
          linkType: 'refers-to',
          to: target.projectId,
          targetType: 'project',
        });
        continue;
      }
      const note = ensureDailyNote(target.day, {
        by: entry.by,
        why: 'Linked from a Block',
        causedBy: entry.causedBy ?? undefined,
      });
      wanted.set(`item:${note.id}`, { from: blockId, linkType: 'refers-to', to: note.id });
    }
    const present = db
      .select({ targetType: links.targetType, toItemId: links.toItemId, toProjectId: links.toProjectId })
      .from(links)
      .leftJoin(items, eq(items.id, links.toItemId))
      .where(
        and(
          eq(links.fromItemId, blockId),
          eq(links.type, 'refers-to'),
          or(eq(links.targetType, 'project'), eq(items.kind, 'daily-note')),
        ),
      )
      .all();
    for (const row of present) {
      const project = row.targetType === 'project';
      const key = project ? `project:${row.toProjectId}` : `item:${row.toItemId}`;
      if (wanted.delete(key)) continue;
      const link: LinkState = project
        ? { from: blockId, linkType: 'refers-to', to: row.toProjectId as string, targetType: 'project' }
        : { from: blockId, linkType: 'refers-to', to: row.toItemId as string };
      recordLink(link, false, { ...entry, why }, at);
    }
    for (const link of wanted.values()) recordLink(link, true, { ...entry, why }, at);
  }

  // After an Item's state is written (from `before`, or newly made): a Block's `[[` links follow its
  // text, when that text is new or changed.
  function afterWrite(
    itemId: string,
    state: ItemState,
    entry: Pick<NewEntry, 'by' | 'causedBy'>,
    at: number,
    before: ItemState | null = null,
  ) {
    if (state.detail?.kind !== 'block') return;
    if (before?.detail?.kind === 'block' && before.detail.text === state.detail.text) return;
    syncBlockLinks(itemId, state.detail.text, entry, at);
  }

  // Linear-backed Todos (linear-todos.ts): kept in step with their issues by every change below.
  const linearTodos = linearTodosIn({
    db,
    now,
    readItems: (ids) =>
      ids.length
        ? withDetails(db.select().from(schema.items).where(inArray(schema.items.id, ids)).all())
        : [],
    change(todo, after, entry) {
      const at = now();
      const before = stateOf(todo);
      const written = writeState(todo, after, at);
      log({ ...entry, itemId: todo.id, before, after: written }, at);
    },
    create(state, issueId, entry) {
      const at = now();
      const identity = { kind: 'todo' as const, source: null, account: null, externalId: null };
      const { id, state: stored } = insertItem(identity, state, at);
      log({ ...entry, action: 'create', itemId: id, before: null, after: stored }, at);
      recordLink({ from: id, linkType: 'made-from', to: issueId }, true, entry, at);
      return id;
    },
    editState: (issue, state, entry) => editFields(issue, { state }, entry, now()),
    catalog: (account) => syncState.catalog(account),
    invalid: (message) => new ItemStoreError('invalid', message),
  });

  function update(
    item: Item,
    changes: Partial<ItemState>,
    entry: Pick<NewEntry, 'by' | 'why' | 'causedBy'>,
    at: number,
  ): ActivityEntry {
    const before = stateOf(item);
    const settled = blockFiling.settled(item.id, item.kind, { ...before, ...changes });
    const after = writeState(item, settled, at);
    const logged = logAndQueue(item, { ...entry, action: 'update', itemId: item.id, before, after }, at);
    blockFiling.afterUpdate({ ...item, ...after }, before, logged, at);
    afterWrite(item.id, after, entry, at, before);
    afterChange(item, before, after, logged);
    return logged;
  }

  // Changes some of a Source Item's synced fields, as `edit-fields` does.
  function editFields(
    item: Item,
    fields: Record<string, unknown>,
    entry: Pick<NewEntry, 'by' | 'why' | 'causedBy'>,
    at: number,
  ): ActivityEntry {
    const before = stateOf(item);
    const edited = editedState(item, fields, (message) => new ItemStoreError('invalid', message));
    const after = writeState(item, edited, at);
    const logged = logAndQueue(item, { ...entry, action: 'update', itemId: item.id, before, after }, at);
    afterChange(item, before, after, logged);
    return logged;
  }

  // What follows a change made in Commander: a ticked Linear Todo writes through to its issue, and a
  // changed issue's Todo follows it.
  function afterChange(item: Item, before: ItemState, after: ItemState, entry: ActivityEntry) {
    if (item.kind === 'todo') linearTodos.writeThrough(item, before, after, entry);
    if (item.kind === 'linear-issue') {
      linearTodos.follow(requireItem(item.id), before, { by: entry.by, causedBy: { entryId: entry.id } });
    }
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
        const created = log({ ...entry, action: 'create', itemId: id, before: null, after: state }, at);
        afterWrite(id, state, entry, at);
        return created;
      }
      case 'update': {
        const item = requireItem(action.itemId);
        projects.checkFiling(action.changes.filing);
        // Filing a Linear Todo files its issue, which the Todo follows: the two never disagree.
        const { filing, ...rest } = action.changes;
        const issue = filing !== undefined ? linearTodos.issueBehind(item) : null;
        if (!issue) return update(item, action.changes, entry, at);
        const filed = update(issue, { filing }, entry, at);
        return Object.keys(rest).length ? update(requireItem(item.id), rest, entry, at) : filed;
      }
      case 'edit-fields':
        return editFields(requireItem(action.itemId), action.fields, entry, at);
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
        if (action.targetType === 'project') link.targetType = 'project';
        requireItem(link.from);
        if (isProjectLink(link)) {
          if (link.linkType !== 'refers-to') {
            throw new ItemStoreError('invalid', 'Only a refers-to Link can point at a Project');
          }
          if (!projects.exists(link.to)) throw new ItemStoreError('not-found', `No Project ${link.to}`);
        } else {
          requireItem(link.to);
          if (link.from === link.to) throw new ItemStoreError('invalid', 'An Item cannot link to itself');
        }
        if (action.type === 'unlink' && !findLink(link)) {
          throw new ItemStoreError('not-found', `No ${link.linkType} Link from ${link.from} to ${link.to}`);
        }
        return recordLink(link, action.type === 'link', entry, at);
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
      const to = isProjectLink(link)
        ? { targetType: 'project' as const, toProjectId: link.to }
        : { targetType: 'item' as const, toItemId: link.to };
      db.insert(links)
        .values({ fromItemId: link.from, type: link.linkType, ...to, createdAt: at })
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
    if (target.action === 'injection-warning') {
      throw new ItemStoreError('invalid', 'An injection warning records what Ares found; it can’t be undone');
    }
    if (target.summary?.length) {
      throw new ItemStoreError('invalid', 'A change the Source made to this Item can’t be undone');
    }
    if (db.select().from(activity).where(eq(activity.undoes, entryId)).get()) {
      throw new ItemStoreError('already-undone', `Activity entry ${entryId} is already undone`);
    }
    const undoEntry = { ...entry, action: 'undo' as const, itemId: target.itemId, undoes: entryId };

    if (target.otherItemId !== null || target.otherProjectId !== null) {
      const wanted = target.before as LinkState | null;
      const link = (target.before ?? target.after) as LinkState;
      const existed = setLink(link, wanted !== null, at);
      const logged = log({ ...undoEntry, ...otherEndOf(link), before: existed, after: wanted }, at);
      if (wanted) blockFiling.afterLink(wanted, logged, at);
      return logged;
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
      // A Source Item's synced fields go back one by one, so nothing changed since is lost.
      const detail = undoneDetail(current.detail, before.detail, after.detail);
      if (detail) restored = { ...restored, detail, status: statusFromDetail(detail, restored.status) };
    }
    const settled = writeState(item, blockFiling.settled(item.id, item.kind, restored), at);
    const logged = logAndQueue(item, { ...undoEntry, before: current, after: settled }, at);
    queueDeletion(item, target, current, settled, logged);
    blockFiling.afterUpdate({ ...item, ...settled }, current, logged, at);
    afterWrite(item.id, settled, entry, at, current);
    afterChange(item, current, settled, logged);
    return logged;
  }

  // A Source Item made in Commander (Send to Linear): undoing its creation deletes it at the Source
  // too, and bringing it back (redo) takes that deletion back while it hasn't been sent.
  function queueDeletion(
    item: Item,
    target: typeof schema.activity.$inferSelect,
    before: ItemState,
    after: ItemState,
    entry: ActivityEntry,
  ) {
    if (!item.source || !item.account || !item.externalId) return;
    const creation = target.action === 'create' && target.actor !== 'source';
    let value: true | null;
    if (creation && before.deletedAt === null && after.deletedAt !== null) value = true;
    else if (before.deletedAt !== null && after.deletedAt === null) value = null;
    else return;
    const { account, source, externalId } = item;
    outgoing.queue({
      account,
      source,
      itemId: item.id,
      externalId,
      field: DELETE_FIELD,
      value,
      synced: null,
      madeAt: entry.at,
      entryId: entry.id,
    });
  }

  // Logs a change, and queues what it changed in a Source Item's synced fields for the Source (Two-way
  // sync), in the same transaction.
  function logAndQueue(item: Item, entry: NewEntry, at: number): ActivityEntry {
    const logged = log(entry, at);
    queueChanges(outgoing, item, entry.before as ItemState, entry.after as ItemState, logged);
    return logged;
  }

  const recordAll = sqlite.transaction((actions: ItemAction[], context: ActionContext): ActivityEntry[] =>
    actions.map((action) => record(action, context)),
  );

  // Send to Linear (linear-send.ts).
  const linearSend = linearSendIn({
    db,
    sqlite,
    readItem,
    insert: (identity, state, at) => insertItem(identity, state, at),
    log,
    link: (link, entry, at) => recordLink(link, true, entry, at),
    update,
    outgoing,
    linearTodos,
    catalog: (account) => syncState.catalog(account),
    catalogs() {
      const { sourceCatalogs } = schema;
      const rows = db.select().from(sourceCatalogs).where(eq(sourceCatalogs.source, 'linear')).all();
      return new Map<string, LinearCatalog | null>(
        rows.map((row) => {
          const parsed = linearCatalog.safeParse(row.catalog);
          return [row.account, parsed.success ? parsed.data : null];
        }),
      );
    },
    rules: () => rules.list(),
    projects: () => projects.list(),
    checkFiling: (filing) => projects.checkFiling(filing),
    invalid: (message) => new ItemStoreError('invalid', message),
  });

  const sendToLinear = sqlite.transaction((draft: LinearIssueDraft, rawContext: ActionContext) => {
    const context = actionContext.parse(rawContext);
    const { activity } = schema;
    const last = db.select({ id: activity.id }).from(activity).orderBy(desc(activity.id)).limit(1).get();
    linearSend.send(draft, { by: context.by, why: context.why, causedBy: context.causedBy }, now());
    return db
      .select()
      .from(activity)
      .where(gt(activity.id, last?.id ?? 0))
      .orderBy(asc(activity.id))
      .all()
      .map(toEntry);
  });

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
        // `#LT` in the template's text files the copy under LT; the Blocks under it inherit that.
        filing: blockFiling.fromText(text),
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
      afterWrite(id, state, entry, at);
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

  // Whether a Daily Note has ever held a Block (deleted ones count: the User wrote in it).
  function everWritten(dailyNoteId: string): boolean {
    const { blockDetails } = schema;
    return !!db
      .select({ id: blockDetails.itemId })
      .from(blockDetails)
      .where(eq(blockDetails.dailyNoteId, dailyNoteId))
      .get();
  }

  // A Daily Note made as today starts with the template if there was none for the day at all, or if
  // the one there was made ahead of time (as a `[[day]]` link's target) and was never written in.
  const ensureFromTemplate = sqlite.transaction((input: string, rawContext: ActionContext): Item => {
    const existing = findDailyNote(calendarDay.parse(input));
    const fresh = !existing || (existing.deletedAt === null && !everWritten(existing.id));
    const note = ensureDailyNote(input, rawContext);
    if (fresh) copyTemplate(note.id, actionContext.parse(rawContext), now());
    return note;
  });

  function mentions(input: MentionQuery): Mention[] {
    const query = mentionQuery.parse(input);
    const { items, blockDetails, dailyNoteDetails } = schema;
    const found: Mention[] = [];
    for (const target of query.targets) {
      const blockIds = backlinks(target)
        .filter((link) => link.type === 'refers-to' && link.from.kind === 'block')
        .map((link) => link.from.id);
      if (!blockIds.length) continue;
      const rows = db
        .select({ item: items, day: dailyNoteDetails.day })
        .from(items)
        .innerJoin(blockDetails, eq(blockDetails.itemId, items.id))
        .innerJoin(dailyNoteDetails, eq(dailyNoteDetails.itemId, blockDetails.dailyNoteId))
        .where(and(inArray(items.id, blockIds), isNull(items.deletedAt)))
        .orderBy(desc(dailyNoteDetails.day), asc(blockDetails.position), asc(items.id))
        .all();
      const blocksFound = withDetails(rows.map((row) => row.item));
      rows.forEach((row, i) => {
        found.push({ target, block: blocksFound[i] as Item, day: row.day });
      });
    }
    return found;
  }

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

  function blockTodos(input: BlockTodoQuery): BlockTodo[] {
    const query = blockTodoQuery.parse(input);
    if (!query.dailyNoteIds?.length && !query.todoIds?.length) return [];
    const { items, links, blockDetails, dailyNoteDetails } = schema;
    const blockItems = alias(items, 'block_items');
    const rows = db
      .select({ todo: items, block: blockItems, day: dailyNoteDetails.day })
      .from(links)
      .innerJoin(items, eq(items.id, links.fromItemId))
      .innerJoin(blockItems, eq(blockItems.id, links.toItemId))
      .innerJoin(blockDetails, eq(blockDetails.itemId, blockItems.id))
      .innerJoin(dailyNoteDetails, eq(dailyNoteDetails.itemId, blockDetails.dailyNoteId))
      .where(
        and(
          eq(links.type, 'made-from'),
          eq(items.kind, 'todo'),
          isNull(items.deletedAt),
          isNull(blockItems.deletedAt),
          query.dailyNoteIds?.length ? inArray(blockDetails.dailyNoteId, query.dailyNoteIds) : undefined,
          query.todoIds?.length ? inArray(items.id, query.todoIds) : undefined,
        ),
      )
      .orderBy(asc(dailyNoteDetails.day), asc(blockDetails.position), asc(items.createdAt))
      .all();
    const todos = withDetails(rows.map((row) => row.todo));
    const blocksFound = withDetails(rows.map((row) => row.block));
    return rows.map((row, i) => ({ todo: todos[i] as Item, block: blocksFound[i] as Item, day: row.day }));
  }

  function blockIssues(dailyNoteIds: string[]): BlockIssue[] {
    if (!dailyNoteIds.length) return [];
    const { items, links, blockDetails } = schema;
    const blockItems = alias(items, 'block_items');
    const rows = db
      .select({ issue: items, blockId: blockItems.id })
      .from(links)
      .innerJoin(items, eq(items.id, links.fromItemId))
      .innerJoin(blockItems, eq(blockItems.id, links.toItemId))
      .innerJoin(blockDetails, eq(blockDetails.itemId, blockItems.id))
      .where(
        and(
          eq(links.type, 'made-from'),
          eq(items.kind, 'linear-issue'),
          isNull(items.deletedAt),
          isNull(blockItems.deletedAt),
          inArray(blockDetails.dailyNoteId, dailyNoteIds),
        ),
      )
      .orderBy(asc(links.id))
      .all();
    const issues = withDetails(rows.map((row) => row.issue));
    return rows.map((row, i) => ({ blockId: row.blockId, issue: issues[i] as Item }));
  }

  function dailyNoteProjects(): DailyNoteProjects[] {
    const rows = sqlite
      .prepare(
        `SELECT d.day AS day, bi.project_id AS projectId
         FROM block_details b
         JOIN items bi ON bi.id = b.item_id
         JOIN items ni ON ni.id = b.daily_note_id
         JOIN daily_note_details d ON d.item_id = b.daily_note_id
         WHERE bi.deleted_at IS NULL AND ni.deleted_at IS NULL AND b.text <> ''
         GROUP BY d.day, bi.project_id
         ORDER BY d.day DESC, bi.project_id`,
      )
      .all() as { day: string; projectId: string | null }[];
    const byDay = new Map<string, DailyNoteProjects>();
    for (const { day, projectId } of rows) {
      const found = byDay.get(day) ?? { day, projectIds: [], unfiled: false };
      byDay.set(day, found);
      if (projectId) found.projectIds.push(projectId);
      else found.unfiled = true;
    }
    return [...byDay.values()];
  }

  function projectBlocks(projectId: string): ProjectBlock[] {
    const { items, blockDetails, dailyNoteDetails } = schema;
    const notes = db
      .selectDistinct({ id: blockDetails.dailyNoteId, day: dailyNoteDetails.day })
      .from(items)
      .innerJoin(blockDetails, eq(blockDetails.itemId, items.id))
      .innerJoin(dailyNoteDetails, eq(dailyNoteDetails.itemId, blockDetails.dailyNoteId))
      .where(and(eq(items.projectId, projectId), isNull(items.deletedAt), sql`${blockDetails.text} <> ''`))
      .orderBy(desc(dailyNoteDetails.day))
      .limit(200)
      .all();
    const all = blocks(notes.map((note) => note.id));
    return notes.flatMap(({ id, day }) => {
      const children = new Map<string | null, Item[]>();
      for (const block of all) {
        if (block.detail?.kind !== 'block' || block.detail.dailyNoteId !== id) continue;
        const siblings = children.get(block.detail.parentId) ?? [];
        children.set(block.detail.parentId, [...siblings, block]);
      }
      const found: ProjectBlock[] = [];
      const walk = (parentId: string | null) => {
        for (const block of children.get(parentId) ?? []) {
          const text = block.detail?.kind === 'block' ? block.detail.text : '';
          if (block.filing?.projectId === projectId && text !== '') found.push({ block, day });
          walk(block.id);
        }
      };
      walk(null);
      return found;
    });
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
    const result: SaveResult = { created: [], updated: [], tombstoned: [], unchanged: [], todos: [] };
    const active = rules.list();
    if (batch.me !== undefined) linearTodos.remember(batch.account, batch.me);
    linearTodos.takeChanged();
    const applyRules = (itemId: string, at: number) => {
      const item = requireItem(itemId);
      const filed = ruleFiling(item, active);
      if (filed) fileByRule(item, filed, at);
    };
    // The Item's Todo (a Linear Todo) follows it, once it is filed.
    const follow = (itemId: string, before: ItemState | null, entryId?: number) =>
      linearTodos.follow(requireItem(itemId), before, { by, causedBy: entryId ? { entryId } : null });
    for (const incoming of batch.items) {
      const at = now();
      const existing = findBySourceIdentity(batch.source, batch.account, incoming.externalId);
      if (existing && existing.deletedAt !== null && outgoing.queued(existing.id, DELETE_FIELD)) {
        // Deleted in Commander (an undone Send to Linear), on its way to being deleted at the Source.
        result.unchanged.push(existing.id);
        continue;
      }
      if (existing) {
        const before = stateOf(existing);
        const after: ItemState = {
          ...before,
          title: incoming.title,
          people: incoming.people,
          deletedAt: null,
          // Changes made in Commander still on their way to the Source stay on top.
          ...withQueuedOnTop(outgoing, existing.id, { status: incoming.status, detail: incoming.detail }),
        };
        if (isDeepStrictEqual(before, after)) {
          result.unchanged.push(existing.id);
          // Still judged: who the User is may be newly known, or the issue's cycle may be over.
          follow(existing.id, before);
          // And still checked, so an Item saved before the steering check gets its mark.
          warnings.check(existing, at, null);
          continue;
        }
        writeState(existing, after, at);
        const logged = log({ by, why: batch.why, action: 'update', itemId: existing.id, before, after }, at);
        applyRules(existing.id, at);
        follow(existing.id, before, logged.id);
        warnings.check(requireItem(existing.id), at, logged.id);
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
      const logged = log(
        { by, why: batch.why, action: 'create', itemId: id, before: null, after: stored },
        at,
      );
      applyRules(id, at);
      follow(id, null, logged.id);
      warnings.check(requireItem(id), at, logged.id);
      result.created.push(id);
    }
    for (const externalId of batch.deleted) {
      const existing = findBySourceIdentity(batch.source, batch.account, externalId);
      if (!existing || existing.deletedAt !== null) continue;
      const at = now();
      const before = stateOf(existing);
      const after: ItemState = { ...before, deletedAt: at };
      writeState(existing, after, at);
      const logged = log({ by, action: 'tombstone', itemId: existing.id, before, after }, at);
      linearTodos.follow(requireItem(existing.id), before, { by, causedBy: { entryId: logged.id } }, true);
      result.tombstoned.push(existing.id);
    }
    result.todos = [...new Set(linearTodos.takeChanged())];
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

  const autonomy = openAutonomyStore(db, now);
  const agent = openAgentStore(db, now);

  return {
    models: openModelStore(db, now),
    syncState,
    outgoing,
    autonomy,
    agent,
    dashboard: openDashboardStore(db, {
      agent,
      autonomy,
      readItem: (id) =>
        withDetails(db.select().from(schema.items).where(eq(schema.items.id, id)).all())[0] ?? null,
    }),
    updates: openUpdateStore(db),
    injectionWarnings: {
      flag: sqlite.transaction((itemId: string) => warnings.flag(itemId)),
      since: (after) => warnings.since(after),
    },
    search: { query: (query) => search.query(query) },

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
            query.ids ? inArray(items.id, query.ids) : undefined,
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
      return { item, links: linksFrom(itemId), backlinks: backlinks({ targetType: 'item', id: itemId }) };
    },

    link(link, context) {
      return record({ type: 'link', ...link }, context);
    },

    backlinks,
    mentions,

    record,
    recordAll,
    sendToLinear,
    linearSendPrefill: (request) => linearSend.prefill(request),
    ensureDailyNote: (day, context, options) =>
      options?.fromTemplate ? ensureFromTemplate(day, context) : ensureDailyNote(day, context),
    dailyNotes,
    blocks,
    dailyTemplate: () => template.read(),
    saveDailyTemplate: (input) => template.save(input),
    blockTodos,
    blockIssues,
    dailyNoteProjects,
    projectBlocks,
    recheckIds: (account) => linearTodos.recheckIds(account),

    fromSource({ source, account }, externalIds) {
      const { items } = schema;
      const found: Item[] = [];
      for (let i = 0; i < externalIds.length; i += 500) {
        const rows = db
          .select()
          .from(items)
          .where(
            and(
              eq(items.source, source),
              eq(items.account, account),
              inArray(items.externalId, externalIds.slice(i, i + 500)),
              isNull(items.deletedAt),
            ),
          )
          .all();
        found.push(...withDetails(rows));
      }
      return found;
    },

    activity(input = {}) {
      const query = activityQuery.parse(input);
      const { activity } = schema;
      return db
        .select()
        .from(activity)
        .where(
          and(
            query.itemId
              ? or(eq(activity.itemId, query.itemId), eq(activity.otherItemId, query.itemId))
              : undefined,
            query.after !== undefined ? gt(activity.id, query.after) : undefined,
          ),
        )
        .orderBy(desc(activity.id))
        .limit(query.limit ?? 200)
        .all()
        .map(toEntry);
    },

    projects: (query) => projects.list(query),

    changeProject: sqlite.transaction((action: ProjectAction) => projects.change(action)),

    rules: () => rules.list(),

    changeRule: sqlite.transaction((action: RuleAction): RuleChange => {
      const change = rules.change(action);
      // Deleting a Rule leaves Items where they are, and so does bringing it back.
      const leavesItems = action.type === 'delete' || action.type === 'restore';
      return { rule: change.rule, refile: leavesItems ? [] : refileCandidates(change) };
    }),

    previewRule(input) {
      const request = rulePreviewRequest.parse(input);
      const matching = sourceItems().filter((item) => ruleMatches(request.rule.when, item));
      const overlaps = rules
        .list()
        .filter(
          (rule) => rule.id !== request.ruleId && matching.some((item) => ruleMatches(rule.when, item)),
        );
      return {
        count: matching.length,
        sample: matching.slice(0, request.sampleSize ?? 8).map(refOf),
        overlaps,
      };
    },

    refile: sqlite.transaction((itemIds: string[]): ActivityEntry[] => {
      const active = rules.list();
      const entries: ActivityEntry[] = [];
      for (const itemId of new Set(itemIds)) {
        const item = readItem(itemId);
        if (!item || item.source === null || item.deletedAt !== null) continue;
        const filed = ruleFiling(item, active);
        if (!filed) continue;
        const logged = fileByRule(item, filed, now());
        entries.push(logged);
        linearTodos.follow(requireItem(item.id), stateOf(item), {
          by: logged.by,
          causedBy: { entryId: logged.id },
        });
      }
      return entries;
    }),

    undoRefile: sqlite.transaction((entryIds: number[]): ActivityEntry[] =>
      undoFilings(entryIds, 'Undid re-filing by Rules', true),
    ),

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
      const snapshot = takeDailySnapshot(sqlite, options.snapshotDir, now());
      // Looking after the images must never cost the snapshot (or the Core) itself.
      try {
        if (snapshot)
          attachments.afterSnapshot(sqlite, keptSnapshots(options.snapshotDir), options.snapshotDir);
      } catch (error) {
        console.warn('Could not snapshot or tidy the attachments:', error);
      }
      return snapshot;
    },

    saveAttachment: (bytes) => attachments.save(bytes),

    projectRef(projectId) {
      try {
        return projectRefOf(projectId);
      } catch (error) {
        if (error instanceof ItemStoreError && error.code === 'not-found') return null;
        throw error;
      }
    },

    markdownCopyFolder: markdownCopyFolderIn(db, now),

    close() {
      sqlite.close();
    },
  };
}
