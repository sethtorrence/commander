import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationLink } from '@commander/domain';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { FAKE_MODEL, fakeEmbedding } from '../meaning/fake';
import { matchingLine } from './conversation-index';
import type { QueryVector } from './meaning-index';

// Conversations in search (#195), through the Item store against a real temporary database: each
// turn is indexed by its words as it is written, and by its meaning once embedded (fixed vectors
// stand in for the model); one hit per Conversation at its best turn, with the line that matched;
// a deleted Conversation leaves the index with it, and Undo puts it back.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const MODEL = 'fixed-vectors';
const DAY = '2026-10-06';

let dir: string;
let store: ItemStore;
let clock: number;

const open = () =>
  openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-conversation-search-'));
  clock = new Date(2026, 9, 6, 9).getTime();
  store = open();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// A Conversation where the User asks and Ares answers `answer` (none: he hasn't yet).
function talk(asked: string, answer?: string, links: ConversationLink[] = []) {
  const { conversation } = store.conversations.create(DAY);
  clock += 1000;
  const turn = store.conversations.addUserTurn(conversation.id, asked);
  if (answer === undefined) return { conversationId: conversation.id, asked: turn.id, answered: null };
  const started = store.conversations.startAnswer(conversation.id, turn.id, 'streaming');
  store.conversations.saveAnswer(started.id, { status: 'done', text: answer, links, endedAt: clock });
  return { conversationId: conversation.id, asked: turn.id, answered: started.id };
}

const found = (text: string, meaning?: QueryVector) =>
  store.search.query({ text }, meaning).conversations ?? [];

const LIMITS = [1, 0, 0, 0];
const TRAVEL = [0, 0, 1, 0];
const near = (direction: number[]): QueryVector => ({
  model: MODEL,
  vector: Float32Array.from(direction),
  minSimilarity: 0.5,
});

// Embeds everything waiting, each by the direction its text is about.
function embedAll(directions: Record<string, number[]>) {
  for (let work = store.meaning.pending(MODEL, 10); work.length; work = store.meaning.pending(MODEL, 10)) {
    store.meaning.save(
      MODEL,
      work.map(({ key, text }) => {
        const match = Object.entries(directions).find(([word]) => text.includes(word));
        return { key, text, vector: Float32Array.from(match?.[1] ?? [0, 0, 0, 1]) };
      }),
    );
  }
}

describe('Conversations found by their words', () => {
  it('finds a Conversation by the User’s words and by Ares’s, at the turn that matched', () => {
    const fjord = talk('What is a fjord?', 'A fjord is a long, narrow inlet\ncarved by glaciers.');
    talk('Remind me what 2 + 2 is', '4.');

    expect(found('fjord')).toEqual([
      {
        conversationId: fjord.conversationId,
        title: 'What is a fjord?',
        day: DAY,
        daily: false,
        turnId: expect.any(Number),
        by: expect.any(String),
        line: expect.stringContaining('fjord'),
        foundBy: ['words'],
      },
    ]);
    // His answer, the line of it that matched.
    expect(found('glaciers')).toMatchObject([
      {
        conversationId: fjord.conversationId,
        turnId: fjord.answered,
        by: 'ares',
        line: 'carved by glaciers.',
      },
    ]);
    // The last word is matched as it is typed.
    expect(found('glac')).toMatchObject([{ turnId: fjord.answered }]);
    expect(found('remind')).toMatchObject([
      { title: 'Remind me what 2 + 2…', by: 'user', line: 'Remind me what 2 + 2 is' },
    ]);
  });

  it('gives one hit for each Conversation, at its best turn', () => {
    const { conversationId, asked } = talk('Plan the Lisbon offsite', 'Lisbon in May is mild.');
    expect(found('lisbon')).toHaveLength(1);
    expect(found('lisbon offsite')).toMatchObject([{ conversationId, turnId: asked }]);
  });

  it('finds an answer only once Ares has written it, with the Items he linked as they show', () => {
    const conversationId = store.conversations.create(DAY).conversation.id;
    const asked = store.conversations.addUserTurn(conversationId, 'Where is the rollout issue?');
    const answer = store.conversations.startAnswer(conversationId, asked.id, 'streaming');
    store.conversations.saveAnswer(answer.id, { skills: ['find'] });
    expect(found('tracked')).toEqual([]);

    const link: ConversationLink = {
      ref: 'I1',
      itemId: 'item-1',
      kind: 'linear-issue',
      title: 'Roll out the new sync',
      label: 'ENG-418',
      section: 'linear',
    };
    store.conversations.saveAnswer(answer.id, {
      status: 'done',
      text: 'It is tracked as [I1].',
      links: [link],
      endedAt: clock,
    });
    expect(found('tracked')).toMatchObject([{ turnId: answer.id, line: 'It is tracked as ENG-418.' }]);
    expect(found('ENG-418')).toMatchObject([{ turnId: answer.id }]);
  });

  it('leaves Conversations out when a filter narrows the search to Items', () => {
    talk('What is a fjord?');
    expect(store.search.query({ text: 'fjord', kinds: ['todo'] }).conversations).toEqual([]);
    expect(store.search.query({ text: 'fjord', from: 0 }).conversations).toEqual([]);
  });

  it('indexes the Conversations already kept when the index is first built', () => {
    const { conversationId } = talk('What is a fjord?', 'A long, narrow inlet.');
    store.close();
    // An older database, from before Conversations were searched.
    const raw = new Database(join(dir, 'commander.db'));
    raw.exec('DROP TABLE conversation_words_meta');
    raw.close();
    store = open();
    expect(found('fjord')).toMatchObject([{ conversationId }]);
    expect(found('inlet')).toMatchObject([{ conversationId, by: 'ares' }]);
  });
});

describe('Conversations found by meaning', () => {
  it('finds a turn sharing no words with the query once it is embedded, and words and meaning together', () => {
    const limits = talk('How do we throttle bursts on sync?', 'Back off on 429s.');
    const travel = talk('Book flights for the offsite');
    embedAll({ throttle: LIMITS, '429': LIMITS, flights: TRAVEL });

    expect(found('the rate limiter thing', near(LIMITS))).toMatchObject([
      { conversationId: limits.conversationId, foundBy: ['meaning'] },
    ]);
    expect(found('flights', near(TRAVEL))).toMatchObject([
      { conversationId: travel.conversationId, foundBy: ['words', 'meaning'] },
    ]);
    // Without the query's embedding, words alone.
    expect(found('the rate limiter thing')).toEqual([]);
  });

  it('embeds a turn again once its words change, and finds it by its old embedding until then', () => {
    const conversationId = store.conversations.create(DAY).conversation.id;
    const asked = store.conversations.addUserTurn(conversationId, 'Anything new?');
    const answer = store.conversations.startAnswer(conversationId, asked.id, 'streaming');
    store.conversations.saveAnswer(answer.id, { status: 'stopped', text: 'Your flights', endedAt: clock });
    embedAll({ flights: TRAVEL });
    expect(store.meaning.pending(MODEL, 10)).toEqual([]);

    store.conversations.saveAnswer(answer.id, { text: 'Your flights are booked' });
    expect(store.meaning.pending(MODEL, 10).map((work) => work.text)).toEqual(['Your flights are booked']);
    expect(found('trip', near(TRAVEL))).toMatchObject([{ turnId: answer.id }]);
  });

  it('counts the turns in how far search by meaning has got', () => {
    talk('How do we throttle bursts on sync?', 'Back off on 429s.');
    expect(store.meaning.progress(MODEL)).toEqual({ embedded: 0, total: 2 });
    embedAll({ throttle: LIMITS, '429': LIMITS });
    expect(store.meaning.progress(MODEL)).toEqual({ embedded: 2, total: 2 });
  });

  it('finds the end-to-end test’s Conversation clearly within the stand-in model’s floor', () => {
    // ask-ares-palette.spec.ts asks "rate limiter" of these turns with the stand-in embeddings.
    const query = fakeEmbedding('rate limiter');
    const similarity = (text: string) =>
      fakeEmbedding(text).reduce((sum, value, index) => sum + value * (query[index] as number), 0);
    for (const turn of ['Should we throttle the bursts?', 'Back off when the rate limit bursts.']) {
      expect(similarity(turn)).toBeGreaterThan(FAKE_MODEL.minSimilarity + 0.2);
    }
  });
});

describe('deleting', () => {
  it('takes a deleted Conversation out of search, by words and meaning, and Undo puts it back', () => {
    const { conversationId } = talk('How do we throttle bursts on sync?', 'Back off on 429s.');
    embedAll({ throttle: LIMITS, '429': LIMITS });
    expect(found('throttle', near(LIMITS))).toHaveLength(1);

    const removed = store.conversations.remove(conversationId);
    expect(found('throttle')).toEqual([]);
    expect(found('the rate limiter thing', near(LIMITS))).toEqual([]);
    expect(store.meaning.pending(MODEL, 10)).toEqual([]);

    store.conversations.restore(removed);
    expect(found('throttle')).toMatchObject([{ conversationId }]);
    // Its turns wait to be embedded again.
    expect(store.meaning.pending(MODEL, 10)).toHaveLength(2);
  });

  it('takes back a failed answer from search with Send again', () => {
    const conversationId = store.conversations.create(DAY).conversation.id;
    const asked = store.conversations.addUserTurn(conversationId, 'Summarise the week');
    const answer = store.conversations.startAnswer(conversationId, asked.id, 'streaming');
    store.conversations.saveAnswer(answer.id, {
      status: 'failed',
      text: 'Halfway through the week',
      problem: 'The call failed.',
      endedAt: clock,
    });
    expect(found('halfway')).toHaveLength(1);
    store.conversations.takeBack(conversationId);
    expect(found('halfway')).toEqual([]);
    expect(found('summarise')).toMatchObject([{ turnId: asked.id }]);
  });
});

describe('the matching line', () => {
  it('is the line with the most words typed, or the first line', () => {
    const text = 'Here is what I found.\n\n- **Lisbon** in May is mild\n- Porto is rainier';
    expect(matchingLine(text, 'porto rain')).toBe('Porto is rainier');
    expect(matchingLine(text, 'lisbon')).toBe('Lisbon in May is mild');
    expect(matchingLine(text, 'weather')).toBe('Here is what I found.');
    expect(matchingLine('Café opening', 'cafe')).toBe('Café opening');
  });

  it('is cut around the first matching word when long', () => {
    const long = `${'word '.repeat(40)}the fjord is here ${'more '.repeat(40)}`.trim();
    const line = matchingLine(long, 'fjord');
    expect(line.startsWith('…')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
    expect(line).toContain('the fjord is here');
    expect(line.length).toBeLessThanOrEqual(142);
  });
});
