import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

const migrationsFolder = join(import.meta.dirname, '../../drizzle');

let dir: string;
let clock: number;
const stores: ItemStore[] = [];

function open() {
  const store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
  stores.push(store);
  return store;
}

function reopen(store: ItemStore) {
  store.close();
  stores.splice(stores.indexOf(store), 1);
  return open();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-conversations-'));
  clock = new Date(2026, 9, 6, 9).getTime();
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Conversations in the Item store', () => {
  it('makes today’s Conversation on the first open of the day, and keeps it and New ones across restarts', () => {
    let store = open();
    const today = store.conversations.today('2026-10-06');
    expect(today.conversation).toMatchObject({
      day: '2026-10-06',
      daily: true,
      title: null,
      answering: false,
    });
    expect(today.turns).toEqual([]);
    // Opening again the same day: the same one.
    expect(store.conversations.today('2026-10-06').conversation.id).toBe(today.conversation.id);
    clock += 1000;
    const another = store.conversations.create('2026-10-06');
    expect(another.conversation).toMatchObject({ daily: false });
    store.conversations.addUserTurn(another.conversation.id, 'What is a fair queue?');

    store = reopen(store);
    expect(store.conversations.list().map((each) => each.id)).toEqual([
      another.conversation.id,
      today.conversation.id,
    ]);
    expect(store.conversations.today('2026-10-06').conversation.id).toBe(today.conversation.id);
    // The next day gets its own.
    expect(store.conversations.today('2026-10-07').conversation.id).not.toBe(today.conversation.id);
  });

  it('names a Conversation from the first words the User wrote', () => {
    const store = open();
    const { conversation } = store.conversations.today('2026-10-06');
    store.conversations.addUserTurn(
      conversation.id,
      '  How do tides work, and why are there two a day?\nThanks',
    );
    expect(store.conversations.conversation(conversation.id)?.title).toBe('How do tides work, and why…');
    const turn = store.conversations.startAnswer(
      conversation.id,
      (store.conversations.view(conversation.id)?.turns[0]?.id as number) ?? 0,
      'streaming',
    );
    store.conversations.saveAnswer(turn.id, { status: 'done', text: 'The Moon.', endedAt: clock });
    store.conversations.addUserTurn(conversation.id, 'Something else entirely');
    // The name stays the first words.
    expect(store.conversations.conversation(conversation.id)?.title).toBe('How do tides work, and why…');
  });

  it('keeps who wrote each turn and when, oldest first', () => {
    const store = open();
    const { conversation } = store.conversations.today('2026-10-06');
    const asked = store.conversations.addUserTurn(conversation.id, 'Hello');
    clock += 500;
    const answer = store.conversations.startAnswer(conversation.id, asked.id, 'streaming');
    clock += 500;
    store.conversations.saveAnswer(answer.id, {
      status: 'done',
      text: 'Hello. What can I do?',
      ownKnowledge: false,
      endedAt: clock,
    });
    expect(store.conversations.view(conversation.id)?.turns).toEqual([
      expect.objectContaining({ by: 'user', text: 'Hello', at: asked.at, status: 'done', replyTo: null }),
      expect.objectContaining({
        by: 'ares',
        text: 'Hello. What can I do?',
        at: asked.at + 500,
        status: 'done',
        replyTo: asked.id,
        endedAt: asked.at + 1000,
      }),
    ]);
    expect(store.conversations.conversation(conversation.id)?.updatedAt).toBe(asked.at + 500);
  });

  it('never lets Ares write unprompted: he only answers the User’s last message, once', () => {
    const store = open();
    const { conversation } = store.conversations.today('2026-10-06');
    // Nothing asked yet.
    expect(() => store.conversations.startAnswer(conversation.id, 1, 'streaming')).toThrow(/only answers/);
    const first = store.conversations.addUserTurn(conversation.id, 'One');
    const answer = store.conversations.startAnswer(conversation.id, first.id, 'streaming');
    // Already answering it.
    expect(() => store.conversations.startAnswer(conversation.id, first.id, 'streaming')).toThrow(
      /only answers/,
    );
    store.conversations.saveAnswer(answer.id, { status: 'done', text: 'Done.', endedAt: clock });
    // Answered already.
    expect(() => store.conversations.startAnswer(conversation.id, first.id, 'streaming')).toThrow(
      /only answers/,
    );
    const second = store.conversations.addUserTurn(conversation.id, 'Two');
    // Not an earlier message.
    expect(() => store.conversations.startAnswer(conversation.id, first.id, 'streaming')).toThrow(
      /only answers/,
    );
    expect(store.conversations.startAnswer(conversation.id, second.id, 'queued').status).toBe('queued');
    // And the User's turns are never his to change.
    expect(() => store.conversations.saveAnswer(second.id, { text: 'changed' })).toThrow();
  });

  it('refuses the User’s message while Ares is still answering', () => {
    const store = open();
    const { conversation } = store.conversations.today('2026-10-06');
    const asked = store.conversations.addUserTurn(conversation.id, 'Tell me a long story');
    const answer = store.conversations.startAnswer(conversation.id, asked.id, 'streaming');
    expect(store.conversations.conversation(conversation.id)?.answering).toBe(true);
    expect(store.conversations.answering(conversation.id)?.id).toBe(answer.id);
    expect(() => store.conversations.addUserTurn(conversation.id, 'Hurry up')).toThrow(/still answering/);
    store.conversations.saveAnswer(answer.id, { status: 'stopped', text: 'Once upon', endedAt: clock });
    expect(store.conversations.conversation(conversation.id)?.answering).toBe(false);
    expect(store.conversations.addUserTurn(conversation.id, 'Shorter, please').by).toBe('user');
  });

  it('takes back a failed answer for Send again, keeping the User’s message', () => {
    const store = open();
    const { conversation } = store.conversations.today('2026-10-06');
    const asked = store.conversations.addUserTurn(conversation.id, 'What is a quaternion?');
    expect(() => store.conversations.takeBack(conversation.id)).toThrow(/nothing|no message/i);
    const failed = store.conversations.startAnswer(conversation.id, asked.id, 'streaming');
    store.conversations.saveAnswer(failed.id, { status: 'failed', problem: 'No key.', endedAt: clock });
    expect(store.conversations.takeBack(conversation.id).id).toBe(asked.id);
    expect(store.conversations.view(conversation.id)?.turns.map((turn) => turn.id)).toEqual([asked.id]);
    // A finished answer isn't taken back.
    const answered = store.conversations.startAnswer(conversation.id, asked.id, 'streaming');
    store.conversations.saveAnswer(answered.id, { status: 'done', text: 'A number system.', endedAt: clock });
    expect(() => store.conversations.takeBack(conversation.id)).toThrow();
  });

  it('removes a Conversation and its turns, and puts them back for Undo', () => {
    const store = open();
    const { conversation } = store.conversations.today('2026-10-06');
    const asked = store.conversations.addUserTurn(conversation.id, 'Keep this');
    const answer = store.conversations.startAnswer(conversation.id, asked.id, 'streaming');
    store.conversations.saveAnswer(answer.id, { status: 'done', text: 'Kept.', endedAt: clock });
    const before = store.conversations.view(conversation.id);

    const removed = store.conversations.remove(conversation.id);
    expect(store.conversations.view(conversation.id)).toBeNull();
    expect(store.conversations.list()).toEqual([]);

    expect(store.conversations.restore(removed)).toEqual(before);
    expect(store.conversations.list().map((each) => each.id)).toEqual([conversation.id]);
  });

  it('puts back a deleted day’s Conversation as an ordinary one when the day has a new one', () => {
    const store = open();
    const first = store.conversations.today('2026-10-06');
    store.conversations.addUserTurn(first.conversation.id, 'First');
    const removed = store.conversations.remove(first.conversation.id);
    const second = store.conversations.today('2026-10-06');
    expect(second.conversation.id).not.toBe(first.conversation.id);
    const back = store.conversations.restore(removed);
    expect(back.conversation).toMatchObject({ id: first.conversation.id, daily: false });
    expect(store.conversations.today('2026-10-06').conversation.id).toBe(second.conversation.id);
  });

  it('lets empty Conversations from earlier days go when the day’s is made', () => {
    const store = open();
    const empty = store.conversations.today('2026-10-05');
    const spoken = store.conversations.create('2026-10-05');
    store.conversations.addUserTurn(spoken.conversation.id, 'Hello');
    const blank = store.conversations.create('2026-10-06');
    store.conversations.today('2026-10-06');
    const left = store.conversations.list().map((each) => each.id);
    expect(left).not.toContain(empty.conversation.id);
    expect(left).toContain(spoken.conversation.id);
    // Today's empty ones stay.
    expect(left).toContain(blank.conversation.id);
  });

  it('fails answers a stopped Core left unfinished, keeping what was written, so they can be sent again', () => {
    let store = open();
    const { conversation } = store.conversations.today('2026-10-06');
    const asked = store.conversations.addUserTurn(conversation.id, 'Go on');
    const answer = store.conversations.startAnswer(conversation.id, asked.id, 'streaming');
    store.conversations.saveAnswer(answer.id, { text: 'Halfway' });
    store = reopen(store);
    expect(store.conversations.settleUnfinished('The core stopped.')).toBe(1);
    expect(store.conversations.turn(answer.id)).toMatchObject({
      status: 'failed',
      text: 'Halfway',
      problem: 'The core stopped.',
    });
    expect(store.conversations.conversation(conversation.id)?.answering).toBe(false);
    expect(store.conversations.takeBack(conversation.id)).toMatchObject({ id: asked.id, text: 'Go on' });
  });
});
