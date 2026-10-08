// Conversations' side of the Item store (#191): each Conversation with Ares and its turns, in the
// Item store's database, so the Item store stays its only writer. What Ares says, and when, is the
// Conversations module's (../conversations). Two things hold here whatever calls it:
// - Ares never writes unprompted: his turn can only be started as the answer to the User's last turn,
//   one answer at a time, and only while that turn has none.
// - The User can't write over him: a message is refused while he is still answering.
// A Conversation started from an Item (#193) keeps that Item's id; naming the Item for the window is
// the Conversations module's, which reads Items (`about` is null here). One started from an Update
// line's Reply box (#236) keeps the queued line's id and the Update's.
// Every turn written here is put in search's index of Conversations (#195) in the same transaction,
// and a deleted Conversation's turns leave it with them (Undo puts them back).
import { randomUUID } from 'node:crypto';
import {
  type Conversation,
  type ConversationAboutLine,
  type ConversationTurn,
  type ConversationView,
  conversationTurn,
  MAX_TURN_TEXT,
  type TurnStatus,
  titleFrom,
} from '@commander/domain';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { ConversationIndex } from '../search';
import * as schema from './schema';

// What Delete took away, for Undo to put back as it was.
export type RemovedConversation = {
  conversation: typeof schema.conversations.$inferSelect;
  turns: (typeof schema.conversationTurns.$inferSelect)[];
};

// What may change on one of Ares's answers as he writes it: also what it rests on (#192), the Items
// it links to, the Update it gave and the Skills he used, what his action Skills handed the gate
// (#196), what he remembered from the User's message (#194), and what his Skills made for it
// to show (#198).
export type AnswerChanges = Partial<
  Pick<
    ConversationTurn,
    | 'status'
    | 'text'
    | 'ownKnowledge'
    | 'problem'
    | 'endedAt'
    | 'links'
    | 'updateId'
    | 'skills'
    | 'proposalIds'
    | 'remembered'
    | 'made'
  >
>;

export type ConversationStore = {
  // Every Conversation, newest first (by its last turn).
  list(): Conversation[];
  conversation(id: string): Conversation | null;
  view(id: string): ConversationView | null;
  // The day's own Conversation, made the first time it is asked for. Empty Conversations from earlier
  // days go then: nothing was said in them.
  today(day: string): ConversationView;
  // New Conversation; `about`, when it is started from an Item (#193), named after it, or from an
  // Update line (#236), named from the User's first words.
  create(
    day: string,
    about?: { itemId: string; title: string | null } | { line: ConversationAboutLine },
  ): ConversationView;
  // The latest Conversation about each of these queued Update lines (#236), by the line's id.
  aboutLines(queuedIds: readonly number[]): Map<number, string>;
  // The User's message. Names the Conversation from its first words. Refused while Ares is answering.
  addUserTurn(conversationId: string, text: string): ConversationTurn;
  // Ares starts answering the User's last turn (or waits his turn to). Refused for any other turn,
  // and for one he has answered or is answering.
  startAnswer(
    conversationId: string,
    replyTo: number,
    status: Extract<TurnStatus, 'queued' | 'streaming'>,
  ): ConversationTurn;
  saveAnswer(turnId: number, changes: AnswerChanges): ConversationTurn;
  turn(turnId: number): ConversationTurn | null;
  // The answer Ares is giving (or waiting to give) in a Conversation, if any.
  answering(conversationId: string): ConversationTurn | null;
  // Send again: takes back a failed answer to the User's last turn (or one stopped before he wrote
  // anything) and returns that turn of the User's, to be answered again.
  takeBack(conversationId: string): ConversationTurn;
  // Removes a Conversation and its turns, returning them for Undo.
  remove(conversationId: string): RemovedConversation;
  // Undo: puts a removed Conversation back as it was (no longer the day's own, if that day has
  // another by now).
  restore(removed: RemovedConversation): ConversationView;
  // Answers still unfinished from a Core that stopped without closing (it crashed, or was ended:
  // closing stops them first, as far as he got): failed with `problem`, keeping what he had written,
  // so the User's message can be sent again.
  settleUnfinished(problem: string): number;
};

export class ConversationError extends Error {
  override name = 'ConversationError';
}

const UNFINISHED: TurnStatus[] = ['queued', 'streaming'];

export function openConversationStore(
  db: BetterSQLite3Database<typeof schema>,
  now: () => number = Date.now,
  // Search's index of Conversations (#195), kept current with every turn written or removed.
  index: Pick<ConversationIndex, 'put' | 'drop'> = { put: () => {}, drop: () => {} },
): ConversationStore {
  const { conversations, conversationTurns } = schema;

  const toTurn = (row: typeof conversationTurns.$inferSelect): ConversationTurn =>
    conversationTurn.parse(row);
  // A turn as written, put in search.
  const indexed = (turn: ConversationTurn): ConversationTurn => {
    index.put(turn);
    return turn;
  };

  // Whether Ares is answering (or waiting to) in each Conversation.
  const answeringIn = (ids: readonly string[]): Set<string> =>
    ids.length
      ? new Set(
          db
            .select({ id: conversationTurns.conversationId })
            .from(conversationTurns)
            .where(
              and(
                inArray(conversationTurns.conversationId, [...ids]),
                inArray(conversationTurns.status, UNFINISHED),
              ),
            )
            .all()
            .map((row) => row.id),
        )
      : new Set();

  // Which of them have a card under one of Ares's answers waiting for the User's Confirm (#196).
  const waitingIn = (ids: readonly string[]): Set<string> =>
    ids.length
      ? new Set(
          db
            .selectDistinct({ id: schema.proposals.conversationId })
            .from(schema.proposals)
            .where(
              and(inArray(schema.proposals.conversationId, [...ids]), eq(schema.proposals.status, 'pending')),
            )
            .all()
            .flatMap((row) => (row.id ? [row.id] : [])),
        )
      : new Set();

  // …or a card for its Update line's own action (#236) waiting, while the line still waits for the User.
  const lineWaitingIn = (ids: readonly string[]): Set<string> =>
    ids.length
      ? new Set(
          db
            .select({ id: conversations.id })
            .from(conversations)
            .innerJoin(schema.updateQueue, eq(schema.updateQueue.id, conversations.aboutQueuedId))
            .where(
              and(
                inArray(conversations.id, [...ids]),
                eq(schema.updateQueue.status, 'queued'),
                sql`exists (select 1 from ${conversationTurns}, json_each(${conversationTurns.made}) as card
                  where ${conversationTurns.conversationId} = ${conversations.id}
                  and json_extract(card.value, '$.kind') = 'line-action'
                  and json_extract(card.value, '$.status') = 'waiting')`,
              ),
            )
            .all()
            .map((row) => row.id),
        )
      : new Set();

  // Which of them end with an answer that failed.
  const failedIn = (ids: readonly string[]): Set<string> => {
    if (!ids.length) return new Set();
    const last = db
      .select({ id: sql<number>`max(${conversationTurns.id})` })
      .from(conversationTurns)
      .where(inArray(conversationTurns.conversationId, [...ids]))
      .groupBy(conversationTurns.conversationId);
    return new Set(
      db
        .select({ id: conversationTurns.conversationId })
        .from(conversationTurns)
        .where(and(inArray(conversationTurns.id, last), eq(conversationTurns.status, 'failed')))
        .all()
        .map((row) => row.id),
    );
  };

  const toConversations = (rows: (typeof conversations.$inferSelect)[]): Conversation[] => {
    const ids = rows.map((row) => row.id);
    const answering = answeringIn(ids);
    const waiting = new Set([...waitingIn(ids), ...lineWaitingIn(ids)]);
    const failed = failedIn(ids);
    return rows.map(({ dailyOf, aboutUpdateId, aboutQueuedId, ...row }) => ({
      ...row,
      daily: dailyOf !== null,
      answering: answering.has(row.id),
      waiting: waiting.has(row.id),
      failed: failed.has(row.id),
      about: null,
      aboutLine:
        aboutUpdateId !== null && aboutQueuedId !== null
          ? { updateId: aboutUpdateId, queuedId: aboutQueuedId }
          : null,
    }));
  };

  function conversation(id: string): Conversation | null {
    const row = db.select().from(conversations).where(eq(conversations.id, id)).get();
    return row ? (toConversations([row])[0] ?? null) : null;
  }

  function turns(conversationId: string): ConversationTurn[] {
    return db
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.conversationId, conversationId))
      .orderBy(asc(conversationTurns.id))
      .all()
      .map(toTurn);
  }

  function view(id: string): ConversationView | null {
    const found = conversation(id);
    return found ? { conversation: found, turns: turns(id) } : null;
  }

  function required(id: string): ConversationView {
    const found = view(id);
    if (!found) throw new ConversationError('That Conversation is no longer in Commander');
    return found;
  }

  function insert(
    day: string,
    daily: boolean,
    about?: { itemId: string; title: string | null } | { line: ConversationAboutLine },
  ): ConversationView {
    const at = now();
    const id = randomUUID();
    const item = about && 'itemId' in about ? about : null;
    const line = about && 'line' in about ? about.line : null;
    db.insert(conversations)
      .values({
        id,
        title: item?.title ?? null,
        day,
        dailyOf: daily ? day : null,
        createdAt: at,
        updatedAt: at,
        aboutItemId: item?.itemId ?? null,
        aboutUpdateId: line?.updateId ?? null,
        aboutQueuedId: line?.queuedId ?? null,
      })
      .run();
    return required(id);
  }

  function lastTurn(conversationId: string) {
    return db
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.conversationId, conversationId))
      .orderBy(desc(conversationTurns.id))
      .get();
  }

  function answering(conversationId: string): ConversationTurn | null {
    const row = db
      .select()
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.conversationId, conversationId),
          inArray(conversationTurns.status, UNFINISHED),
        ),
      )
      .get();
    return row ? toTurn(row) : null;
  }

  const touch = (conversationId: string, at: number) =>
    db.update(conversations).set({ updatedAt: at }).where(eq(conversations.id, conversationId)).run();

  return {
    list() {
      return toConversations(
        db
          .select()
          .from(conversations)
          .orderBy(desc(conversations.updatedAt), desc(conversations.createdAt))
          .all(),
      );
    },

    conversation,
    view,

    today(day) {
      return db.transaction(() => {
        // Empty Conversations from earlier days: nothing was said in them, so nothing is lost.
        const empty = db
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              lt(conversations.day, day),
              sql`not exists (select 1 from ${conversationTurns} where ${conversationTurns.conversationId} = ${conversations.id})`,
            ),
          )
          .all()
          .map((row) => row.id);
        if (empty.length) db.delete(conversations).where(inArray(conversations.id, empty)).run();
        const daily = db.select().from(conversations).where(eq(conversations.dailyOf, day)).get();
        return daily ? required(daily.id) : insert(day, true);
      });
    },

    create(day, about) {
      return insert(day, false, about);
    },

    aboutLines(queuedIds) {
      if (!queuedIds.length) return new Map();
      const rows = db
        .select({ id: conversations.id, queuedId: conversations.aboutQueuedId })
        .from(conversations)
        .where(inArray(conversations.aboutQueuedId, [...queuedIds]))
        .orderBy(asc(conversations.createdAt))
        .all();
      // The newest last, so it is the one kept.
      return new Map(rows.map((row) => [row.queuedId as number, row.id]));
    },

    addUserTurn(conversationId, raw) {
      const text = raw.trim();
      if (!text) throw new ConversationError('There is nothing to send');
      if (text.length > MAX_TURN_TEXT) throw new ConversationError('That message is too long to send');
      return db.transaction(() => {
        const found = required(conversationId);
        if (answering(conversationId)) {
          throw new ConversationError('Ares is still answering. Stop him first, or wait for him to finish.');
        }
        const at = now();
        const row = db
          .insert(conversationTurns)
          .values({ conversationId, by: 'user', text, at, status: 'done', replyTo: null, endedAt: at })
          .returning()
          .get();
        db.update(conversations)
          .set({ updatedAt: at, ...(found.conversation.title === null ? { title: titleFrom(text) } : {}) })
          .where(eq(conversations.id, conversationId))
          .run();
        return indexed(toTurn(row));
      });
    },

    startAnswer(conversationId, replyTo, status) {
      return db.transaction(() => {
        required(conversationId);
        const last = lastTurn(conversationId);
        // Ares only ever answers: the turn must be the User's, and the last in the Conversation.
        if (last?.by !== 'user' || last.id !== replyTo) {
          throw new ConversationError('Ares only answers the User’s last message');
        }
        const at = now();
        const row = db
          .insert(conversationTurns)
          .values({ conversationId, by: 'ares', text: '', at, status, replyTo, ownKnowledge: false })
          .returning()
          .get();
        touch(conversationId, at);
        return toTurn(row);
      });
    },

    saveAnswer(turnId, changes) {
      return db.transaction(() => {
        const row = db
          .update(conversationTurns)
          .set(changes)
          .where(and(eq(conversationTurns.id, turnId), eq(conversationTurns.by, 'ares')))
          .returning()
          .get();
        if (!row) throw new ConversationError(`No answer ${turnId}`);
        return indexed(toTurn(row));
      });
    },

    turn(turnId) {
      const row = db.select().from(conversationTurns).where(eq(conversationTurns.id, turnId)).get();
      return row ? toTurn(row) : null;
    },

    answering,

    takeBack(conversationId) {
      return db.transaction(() => {
        required(conversationId);
        const last = lastTurn(conversationId);
        const again =
          last?.by === 'ares' &&
          (last.status === 'failed' || (last.status === 'stopped' && last.text.trim() === ''));
        if (!last || !again || last.replyTo === null) {
          throw new ConversationError('There is no message of yours waiting to be sent again');
        }
        db.delete(conversationTurns).where(eq(conversationTurns.id, last.id)).run();
        index.drop([last.id]);
        const asked = db.select().from(conversationTurns).where(eq(conversationTurns.id, last.replyTo)).get();
        if (!asked) throw new ConversationError('There is no message of yours waiting to be sent again');
        return toTurn(asked);
      });
    },

    remove(conversationId) {
      return db.transaction(() => {
        const row = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
        if (!row) throw new ConversationError('That Conversation is no longer in Commander');
        const kept = db
          .select()
          .from(conversationTurns)
          .where(eq(conversationTurns.conversationId, conversationId))
          .orderBy(asc(conversationTurns.id))
          .all();
        db.delete(conversationTurns).where(eq(conversationTurns.conversationId, conversationId)).run();
        db.delete(conversations).where(eq(conversations.id, conversationId)).run();
        index.drop(kept.map((turn) => turn.id));
        return { conversation: row, turns: kept };
      });
    },

    restore({ conversation: row, turns: kept }) {
      return db.transaction(() => {
        if (db.select().from(conversations).where(eq(conversations.id, row.id)).get())
          return required(row.id);
        const taken =
          row.dailyOf !== null &&
          db.select().from(conversations).where(eq(conversations.dailyOf, row.dailyOf)).get() !== undefined;
        db.insert(conversations)
          .values({ ...row, dailyOf: taken ? null : row.dailyOf })
          .run();
        // An answer cut off by the delete stays as far as he got.
        const at = now();
        for (const turn of kept) {
          const unfinished = UNFINISHED.includes(turn.status);
          const back = db
            .insert(conversationTurns)
            .values(unfinished ? { ...turn, status: 'stopped', endedAt: turn.endedAt ?? at } : turn)
            .returning()
            .get();
          index.put(toTurn(back));
        }
        return required(row.id);
      });
    },

    settleUnfinished(problem) {
      const at = now();
      return db.transaction(() => {
        const settled = db
          .update(conversationTurns)
          .set({ status: 'failed', problem, endedAt: at })
          .where(inArray(conversationTurns.status, UNFINISHED))
          .returning()
          .all();
        for (const row of settled) index.put(toTurn(row));
        return settled.length;
      });
    },
  };
}
