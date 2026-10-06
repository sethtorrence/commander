// Conversations' side of the Item store (#191): each Conversation with Ares and its turns, in the
// Item store's database, so the Item store stays its only writer. What Ares says, and when, is the
// Conversations module's (../conversations). Two things hold here whatever calls it:
// - Ares never writes unprompted: his turn can only be started as the answer to the User's last turn,
//   one answer at a time, and only while that turn has none.
// - The User can't write over him: a message is refused while he is still answering.
import { randomUUID } from 'node:crypto';
import {
  type Conversation,
  type ConversationTurn,
  type ConversationView,
  conversationTurn,
  MAX_TURN_TEXT,
  type TurnStatus,
  titleFrom,
} from '@commander/domain';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

// What Delete took away, for Undo to put back as it was.
export type RemovedConversation = {
  conversation: typeof schema.conversations.$inferSelect;
  turns: (typeof schema.conversationTurns.$inferSelect)[];
};

// What may change on one of Ares's answers as he writes it: also what it rests on (#192), the Items
// it links to, the Update it gave and the Skills he used.
export type AnswerChanges = Partial<
  Pick<
    ConversationTurn,
    'status' | 'text' | 'ownKnowledge' | 'problem' | 'endedAt' | 'links' | 'updateId' | 'skills'
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
  // New Conversation.
  create(day: string): ConversationView;
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
  // Answers left unfinished when Commander last closed: stopped, keeping what he had written.
  settleUnfinished(): number;
};

export class ConversationError extends Error {
  override name = 'ConversationError';
}

const UNFINISHED: TurnStatus[] = ['queued', 'streaming'];

export function openConversationStore(
  db: BetterSQLite3Database<typeof schema>,
  now: () => number = Date.now,
): ConversationStore {
  const { conversations, conversationTurns } = schema;

  const toTurn = (row: typeof conversationTurns.$inferSelect): ConversationTurn =>
    conversationTurn.parse(row);

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

  const toConversations = (rows: (typeof conversations.$inferSelect)[]): Conversation[] => {
    const answering = answeringIn(rows.map((row) => row.id));
    return rows.map(({ dailyOf, ...row }) => ({
      ...row,
      daily: dailyOf !== null,
      answering: answering.has(row.id),
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

  function insert(day: string, daily: boolean): ConversationView {
    const at = now();
    const id = randomUUID();
    db.insert(conversations)
      .values({ id, title: null, day, dailyOf: daily ? day : null, createdAt: at, updatedAt: at })
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

    create(day) {
      return insert(day, false);
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
        return toTurn(row);
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
      const row = db
        .update(conversationTurns)
        .set(changes)
        .where(and(eq(conversationTurns.id, turnId), eq(conversationTurns.by, 'ares')))
        .returning()
        .get();
      if (!row) throw new ConversationError(`No answer ${turnId}`);
      return toTurn(row);
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
          db.insert(conversationTurns)
            .values(unfinished ? { ...turn, status: 'stopped', endedAt: turn.endedAt ?? at } : turn)
            .run();
        }
        return required(row.id);
      });
    },

    settleUnfinished() {
      const at = now();
      return db
        .update(conversationTurns)
        .set({ status: 'stopped', endedAt: at })
        .where(inArray(conversationTurns.status, UNFINISHED))
        .run().changes;
    },
  };
}
