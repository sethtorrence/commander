import { randomUUID } from 'node:crypto';
import {
  type Bucket,
  describeRule,
  type ItemRef,
  type Memory,
  type MemoryAction,
  type MemoryChange,
  type MemoryKind,
  type MemoryQuery,
  memoryAction,
  memoryQuery,
  normaliseHandle,
  type Person,
  type Project,
  type Rule,
  type WhatAresKnows,
} from '@commander/domain';
import type Database from 'better-sqlite3';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../item-store/schema';
import type { EmbeddedWork, MeaningProgress, MeaningWork, QueryVector } from '../search/meaning-index';
import { fuseRanked } from '../search/retriever';
import { openMemoryFields } from './fields';
import { openMemoryMeaning } from './meaning';
import type { MemoryFoundBy, MemoryRetriever, RetrieverQuery } from './retriever';
import { openMemoryWords } from './words';

export type { MemoryFoundBy, MemoryRetriever } from './retriever';

/*
  Memory (#74, ADR 0006): what Ares has learned and keeps about the User's world, behind one small
  interface. The Item store opens it on the same database and is its only writer: Ares's learners
  `learn`, the User `change`s, What Ares knows `list`s, and Ares's jobs `lookup` the memories about
  what they are working on. Everything about how memories are stored, indexed and found stays in
  here:

  - Rule memories are the Rules themselves, shown as memories; they are changed only in the Rules list.
  - A memory learned again (the same `key`) gains the new sources rather than repeating; a deleted
    one is kept as a tombstone so it is never learned again.
  - Every saved memory is indexed at once (words.ts), in the same transaction; its embedding (#73,
    meaning.ts) is made in the background and saved later.
  - A lookup fuses the retrievers (retriever.ts): its words, the People and Projects it is about, and,
    when the lookup brings the embedding of what it is about, its meaning.
  - A fact whose source was deleted is for review: listed apart, and never looked up, until the User
    keeps it.
*/

export type LearnedMemory = {
  kind: Exclude<MemoryKind, 'rule'>;
  text: string;
  // Confirmed: the User's (their words or their answer); otherwise only ever background.
  confirmed: boolean;
  // Ares learned it (the default), or the User wrote it.
  by?: 'ares' | 'user';
  // What learned it (a correction's activity entry, say): learning the same key again adds its
  // sources to the memory already learned, and a key the User deleted is never learned again.
  key?: string;
  personId?: string | null;
  projectId?: string | null;
  // The people it is about, as handles.
  handles?: readonly string[];
  // Words it is also found by, never shown.
  keywords?: string;
  // The Items it came from.
  sources: readonly string[];
};

export type MemoryLookup = {
  // The words of what Ares is working on (an Item's title, its Source fields, some of its text).
  text: string;
  // Who and what it involves: handles (every handle of their People counts), People and Projects.
  handles?: readonly string[];
  personIds?: readonly string[];
  projectIds?: readonly string[];
  kinds?: readonly MemoryKind[];
  limit?: number;
  // The text embedded (#73): memories are found by meaning too.
  meaning?: QueryVector;
};

export type RecalledMemory = Memory & { foundBy: MemoryFoundBy[] };

export type MemoryStore = {
  // Ares (or the User) learns something. Null when its key was deleted by the User. Call inside a
  // transaction.
  learn(memory: LearnedMemory): Memory | null;
  // One of the User's changes. Call inside a transaction.
  change(action: MemoryAction): MemoryChange;
  // What Ares knows, as its page shows it: everything, or what matches the words typed.
  list(query?: MemoryQuery): WhatAresKnows;
  // The palette's Memory group: what matches the words typed (or, with their embedding, their
  // meaning), best first.
  search(text: string, limit: number, meaning?: QueryVector): Memory[];
  // The live memories about what a job is working on, best first: never deleted ones, nor facts
  // waiting for review, nor rule memories (jobs read the Rules themselves).
  lookup(request: MemoryLookup): RecalledMemory[];
  get(memoryId: string): Memory | null;
  // Which of these keys have been learned (deleted ones included).
  knows(keys: readonly string[]): Set<string>;
  // How far a learner has got (null before it starts), and saving it (inside a transaction).
  progress(name: string): number | null;
  saveProgress(name: string, value: number): void;
  // Search by meaning (#73): the memories waiting to be embedded, and saving their embeddings.
  meaning: {
    pending(model: string, limit: number): MeaningWork[];
    save(model: string, done: readonly EmbeddedWork[]): void;
    progress(model: string): MeaningProgress;
  };
};

export type MemorySources = {
  // Items by id, tombstones included; an id missing from the map is no longer held at all.
  refs(itemIds: readonly string[]): Map<string, ItemRef>;
  rules(): Rule[];
  // Every Project, archived ones too, and the Buckets, for naming a Rule's target.
  projects(): Project[];
  buckets?(): Bucket[];
  people(): Person[];
  error(code: 'invalid' | 'not-found', message: string): Error;
};

type Row = typeof schema.memories.$inferSelect;

const RULE_PREFIX = 'rule:';
const DEFAULT_LOOKUP = 8;
const MAX_TEXT = 1000;
const MAX_KEYWORDS = 2000;

const clean = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

const WORD = /[\p{L}\p{N}]+/gu;
const wordsOf = (text: string) => (text.match(WORD) ?? []).map((word) => word.toLowerCase());

export function openMemory({
  db,
  sqlite,
  now,
  sources,
  onMeaningPending,
}: {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: Database.Database;
  now: () => number;
  sources: MemorySources;
  // A memory waits to be embedded (#73). Called inside the save's transaction: only schedule work.
  onMeaningPending?: () => void;
}): MemoryStore {
  const { memories, memorySources, memoryProgress } = schema;

  const indexed = (row: Row) => ({
    id: row.id,
    kind: row.kind,
    text: row.text,
    keywords: row.keywords,
    handles: row.handles,
  });
  function* live() {
    for (const row of db.select().from(memories).where(isNull(memories.deletedAt)).all()) yield indexed(row);
  }
  const words = openMemoryWords(sqlite, live);
  const meaning = openMemoryMeaning(sqlite);
  const retrievers: MemoryRetriever[] = [words, openMemoryFields(sqlite, live), meaning];
  const index = (row: Row) => {
    for (const retriever of retrievers) retriever.put?.(indexed(row));
    onMeaningPending?.();
  };

  const row = (memoryId: string) => db.select().from(memories).where(eq(memories.id, memoryId)).get();

  // Memories as the window and the jobs see them, with their sources and whether each is for review.
  function toMemories(rows: readonly Row[]): Memory[] {
    if (!rows.length) return [];
    const links = db
      .select()
      .from(memorySources)
      .where(
        inArray(
          memorySources.memoryId,
          rows.map((each) => each.id),
        ),
      )
      .orderBy(memorySources.at)
      .all();
    const refs = sources.refs([...new Set(links.map((link) => link.itemId))]);
    const byMemory = new Map<string, string[]>();
    for (const link of links)
      byMemory.set(link.memoryId, [...(byMemory.get(link.memoryId) ?? []), link.itemId]);
    return rows.map((each) => {
      const found = (byMemory.get(each.id) ?? []).map((itemId) => ({
        itemId,
        item: refs.get(itemId) ?? null,
      }));
      const kept = each.keptAt;
      const gone = found.some(({ item }) =>
        item === null ? kept === null : item.deletedAt !== null && (kept === null || item.deletedAt > kept),
      );
      return {
        id: each.id,
        kind: each.kind,
        text: each.text,
        confirmed: each.confirmed,
        by: each.by,
        personId: each.personId,
        projectId: each.projectId,
        ruleId: null,
        sources: found,
        learnedAt: each.learnedAt,
        updatedAt: each.updatedAt,
        forReview: each.kind === 'fact' && gone,
      };
    });
  }

  // The Rules (Project Rules and Bucket Rules), as memories: their order is the list's.
  function ruleMemories(): Memory[] {
    const projects = new Map(sources.projects().map((project) => [project.id, project]));
    const buckets = new Map((sources.buckets?.() ?? []).map((bucket) => [bucket.id, bucket]));
    return sources.rules().map((rule) => {
      const target = rule.target;
      let into: string;
      if (target.kind === 'project') {
        const project = projects.get(target.projectId);
        into = project ? `${project.code} · ${project.name}` : 'a Project';
      } else {
        into = `${buckets.get(target.bucketId)?.name ?? 'a Bucket'} (Bucket)`;
      }
      return {
        id: `${RULE_PREFIX}${rule.id}`,
        kind: 'rule',
        text: `${describeRule(rule.when)} → ${into}`,
        confirmed: true,
        by: 'user',
        personId: null,
        projectId: target.kind === 'project' ? target.projectId : null,
        ruleId: rule.id,
        sources: [],
        learnedAt: rule.createdAt,
        updatedAt: rule.createdAt,
        forReview: false,
      };
    });
  }

  function addSources(memoryId: string, itemIds: readonly string[], at: number): boolean {
    let added = false;
    for (const itemId of new Set(itemIds)) {
      const result = db.insert(memorySources).values({ memoryId, itemId, at }).onConflictDoNothing().run();
      if (result.changes) added = true;
    }
    return added;
  }

  function requireStored(memoryId: string): Row {
    if (memoryId.startsWith(RULE_PREFIX)) {
      throw sources.error('invalid', 'A Rule is changed only in the Rules list (Settings → Rules)');
    }
    const found = row(memoryId);
    if (!found || found.deletedAt !== null) throw sources.error('not-found', `No memory ${memoryId}`);
    return found;
  }

  function update(memoryId: string, changes: Partial<Row>): Memory {
    db.update(memories)
      .set({ ...changes, updatedAt: now() })
      .where(eq(memories.id, memoryId))
      .run();
    const updated = row(memoryId) as Row;
    index(updated);
    return toMemories([updated])[0] as Memory;
  }

  // Who a lookup is about, widened: every handle of each Person named or holding a handle named.
  function widen(request: MemoryLookup): Pick<RetrieverQuery, 'personIds' | 'handles' | 'projectIds'> {
    const handles = new Set((request.handles ?? []).map(normaliseHandle));
    const personIds = new Set(request.personIds ?? []);
    if (handles.size || personIds.size) {
      for (const person of sources.people()) {
        const theirs = person.handles.map((each) => normaliseHandle(each.handle));
        if (personIds.has(person.id) || theirs.some((handle) => handles.has(handle))) {
          personIds.add(person.id);
          for (const handle of theirs) handles.add(handle);
        }
      }
    }
    return { personIds: [...personIds], handles: [...handles], projectIds: [...(request.projectIds ?? [])] };
  }

  const nobody = { personIds: [], handles: [], projectIds: [] };

  // The live stored memories matching the words typed, best first.
  function typed(text: string, limit: number): Memory[] {
    const ids = words.retrieve({ ...nobody, text, typed: true }, limit);
    return loadInOrder(ids.map((hit) => hit.id));
  }

  function loadInOrder(ids: readonly string[]): Memory[] {
    if (!ids.length) return [];
    const rows = db
      .select()
      .from(memories)
      .where(and(inArray(memories.id, [...ids]), isNull(memories.deletedAt)))
      .all();
    const byId = new Map(toMemories(rows).map((each) => [each.id, each]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  const rulesMatching = (text: string) => {
    const typedWords = wordsOf(text);
    return ruleMemories().filter((rule) => {
      const ruleWords = wordsOf(rule.text);
      return typedWords.every((word) => ruleWords.some((candidate) => candidate.startsWith(word)));
    });
  };

  const store: MemoryStore = {
    learn(input) {
      const at = now();
      const text = clean(input.text, MAX_TEXT);
      if (!text) throw sources.error('invalid', 'A memory can’t be empty');
      const keywords = clean(input.keywords ?? '', MAX_KEYWORDS);
      const handles = [...new Set((input.handles ?? []).map(normaliseHandle))];
      const known = input.key
        ? db.select().from(memories).where(eq(memories.key, input.key)).get()
        : undefined;
      if (known) {
        if (known.deletedAt !== null) return null;
        const added = addSources(known.id, input.sources, at);
        const changes: Partial<Row> = {};
        if (known.editedAt === null && known.text !== text) changes.text = text;
        if (keywords && known.keywords !== keywords) changes.keywords = keywords;
        if (input.confirmed && !known.confirmed) changes.confirmed = true;
        if (!known.personId && input.personId) changes.personId = input.personId;
        if (!known.projectId && input.projectId) changes.projectId = input.projectId;
        const moreHandles = handles.filter((handle) => !known.handles.includes(handle));
        if (moreHandles.length) changes.handles = [...known.handles, ...moreHandles];
        if (!added && !Object.keys(changes).length) return toMemories([known])[0] as Memory;
        return update(known.id, changes);
      }
      const id = randomUUID();
      const inserted = db
        .insert(memories)
        .values({
          id,
          kind: input.kind,
          text,
          keywords,
          confirmed: input.confirmed,
          by: input.by ?? 'ares',
          key: input.key ?? null,
          personId: input.personId ?? null,
          projectId: input.projectId ?? null,
          handles,
          learnedAt: at,
          updatedAt: at,
          editedAt: null,
          keptAt: null,
          deletedAt: null,
        })
        .returning()
        .get();
      addSources(id, input.sources, at);
      index(inserted);
      return toMemories([inserted])[0] as Memory;
    },

    change(raw) {
      const action = memoryAction.parse(raw);
      switch (action.type) {
        case 'add-preference':
          return {
            memory: store.learn({
              kind: 'preference',
              text: action.text,
              confirmed: true,
              by: 'user',
              sources: [],
            }),
          };
        case 'edit':
          requireStored(action.memoryId);
          return {
            memory: update(action.memoryId, {
              text: clean(action.text, MAX_TEXT),
              confirmed: true,
              editedAt: now(),
            }),
          };
        case 'confirm':
          requireStored(action.memoryId);
          return { memory: update(action.memoryId, { confirmed: true }) };
        case 'keep':
          requireStored(action.memoryId);
          return { memory: update(action.memoryId, { keptAt: now() }) };
        case 'delete': {
          requireStored(action.memoryId);
          const at = now();
          db.update(memories)
            .set({ deletedAt: at, updatedAt: at })
            .where(eq(memories.id, action.memoryId))
            .run();
          for (const retriever of retrievers) retriever.drop?.(action.memoryId);
          return { memory: null };
        }
      }
    },

    list(raw = {}) {
      const query = memoryQuery.parse(raw);
      const text = query.text?.trim() ?? '';
      let stored: Memory[];
      let rules: Memory[];
      if (text) {
        stored = typed(text, 500);
        rules = rulesMatching(text);
      } else {
        stored = toMemories(
          db
            .select()
            .from(memories)
            .where(isNull(memories.deletedAt))
            .orderBy(desc(memories.learnedAt), desc(sql`rowid`))
            .all(),
        );
        rules = ruleMemories();
      }
      return {
        forReview: stored.filter((each) => each.forReview),
        memories: [...stored.filter((each) => !each.forReview), ...rules],
      };
    },

    search(text, limit, vector) {
      if (!wordsOf(text).length) return [];
      const found = vector
        ? loadInOrder(
            fuseRanked(
              [
                { foundBy: 'words', hits: words.retrieve({ ...nobody, text, typed: true }, limit) },
                { foundBy: 'meaning', hits: meaning.retrieve({ ...nobody, text, meaning: vector }, limit) },
              ],
              limit,
            ).map((hit) => hit.id),
          )
        : typed(text, limit);
      return [...found, ...rulesMatching(text)].slice(0, limit);
    },

    lookup(request) {
      const limit = request.limit ?? DEFAULT_LOOKUP;
      const kinds = (request.kinds ?? ['example', 'fact', 'preference']).filter((kind) => kind !== 'rule');
      if (!kinds.length) return [];
      const query: RetrieverQuery = {
        text: request.text,
        kinds,
        meaning: request.meaning,
        ...widen(request),
      };
      // Room for what is dropped after fusing (facts waiting for review).
      const fused = fuseRanked(
        retrievers.map((retriever) => ({
          foundBy: retriever.foundBy,
          hits: retriever.retrieve(query, limit * 3),
        })),
        limit * 3,
      );
      const loaded = new Map(loadInOrder(fused.map((hit) => hit.id)).map((each) => [each.id, each]));
      return fused
        .flatMap((hit) => {
          const found = loaded.get(hit.id);
          return found && !found.forReview ? [{ ...found, foundBy: hit.foundBy }] : [];
        })
        .slice(0, limit);
    },

    get(memoryId) {
      if (memoryId.startsWith(RULE_PREFIX))
        return ruleMemories().find((each) => each.id === memoryId) ?? null;
      const found = row(memoryId);
      return found && found.deletedAt === null ? (toMemories([found])[0] as Memory) : null;
    },

    knows(keys) {
      if (!keys.length) return new Set();
      const found = new Set<string>();
      for (let i = 0; i < keys.length; i += 500) {
        for (const each of db
          .select({ key: memories.key })
          .from(memories)
          .where(inArray(memories.key, keys.slice(i, i + 500)))
          .all()) {
          if (each.key) found.add(each.key);
        }
      }
      return found;
    },

    progress(name) {
      return db.select().from(memoryProgress).where(eq(memoryProgress.name, name)).get()?.value ?? null;
    },

    saveProgress(name, value) {
      db.insert(memoryProgress)
        .values({ name, value })
        .onConflictDoUpdate({ target: memoryProgress.name, set: { value } })
        .run();
    },

    meaning: { pending: meaning.pending, save: meaning.save, progress: meaning.progress },
  };
  return store;
}
