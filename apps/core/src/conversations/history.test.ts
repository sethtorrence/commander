import type { ConversationTurn } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import type { PromptTurn } from '../agent/prompt';
import { HISTORY_BUDGET_CHARS, historyOf, historyWithin } from './history';

const user = (text: string): PromptTurn => ({ by: 'user', text });
const ares = (text: string): PromptTurn => ({ by: 'ares', text });

let nextId = 1;
function turn(overrides: Partial<ConversationTurn>): ConversationTurn {
  return {
    id: nextId++,
    conversationId: 'c1',
    by: 'user',
    text: '',
    at: 0,
    status: 'done',
    replyTo: null,
    ownKnowledge: false,
    problem: null,
    endedAt: 0,
    links: [],
    updateId: null,
    skills: [],
    proposalIds: [],
    remembered: [],
    ...overrides,
  };
}

describe('what of a Conversation goes back to the model', () => {
  it('is the User’s turns and what Ares said, up to the message he is answering', () => {
    nextId = 1;
    const turns = [
      turn({ text: 'What is a fjord?' }),
      turn({ by: 'ares', text: 'A long, narrow sea inlet.', replyTo: 1 }),
      turn({ text: 'And a firth?' }),
      // Failed: no words of his to go back.
      turn({ by: 'ares', status: 'failed', text: '', problem: 'No key.', replyTo: 3 }),
      turn({ text: 'Try again: a firth?' }),
      // Stopped early: what he got to goes back.
      turn({ by: 'ares', status: 'stopped', text: 'A firth is', replyTo: 5 }),
      turn({ text: 'Thanks. And a loch?' }),
      // His answer to it, being written now, is not history.
      turn({ by: 'ares', status: 'streaming', text: 'A lo', replyTo: 7 }),
    ];
    expect(historyOf(turns, 7)).toEqual([
      user('What is a fjord?'),
      ares('A long, narrow sea inlet.'),
      user('And a firth?'),
      user('Try again: a firth?'),
      ares('A firth is'),
      user('Thanks. And a loch?'),
    ]);
  });

  it('takes the refs out of his earlier answers: a later answer’s refs name other Items', () => {
    nextId = 1;
    const turns = [
      turn({ text: 'Find the Acme redlines' }),
      turn({ by: 'ares', text: 'Leo sent them on Tuesday [I1], and Dana replied [I2].', replyTo: 1 }),
      turn({ text: 'Thanks [I1]' }),
    ];
    expect(historyOf(turns, 3)).toEqual([
      user('Find the Acme redlines'),
      ares('Leo sent them on Tuesday, and Dana replied.'),
      // The User's own words go back as they wrote them.
      user('Thanks [I1]'),
    ]);
  });

  it('keeps everything that fits the budget', () => {
    const turns = [user('one'), ares('two'), user('three')];
    expect(historyWithin(turns, 100)).toEqual(turns);
    expect(HISTORY_BUDGET_CHARS).toBeGreaterThan(10_000);
  });

  it('drops the oldest turns first until the rest fit, starting with one of the User’s', () => {
    const turns = [
      user('a'.repeat(40)),
      ares('b'.repeat(40)),
      user('c'.repeat(40)),
      ares('d'.repeat(40)),
      user('e'.repeat(40)),
    ];
    // 200 characters; 130 fit the last three only, and the kept part starts with the User.
    expect(historyWithin(turns, 130)).toEqual(turns.slice(2));
    // 90 would leave an answer of his first: that goes too.
    expect(historyWithin(turns, 90)).toEqual(turns.slice(4));
  });

  it('always keeps the message being answered, however long', () => {
    const turns = [user('short'), ares('reply'), user('x'.repeat(500))];
    expect(historyWithin(turns, 100)).toEqual([turns[2]]);
    expect(historyWithin([], 100)).toEqual([]);
  });
});
