import { describe, expect, it } from 'vitest';
import { normaliseMessageId, parseMessageIds, type ThreadingMessage, threadMessages } from './email';

// Threading emails (decision #20): by reply headers (Message-ID, In-Reply-To, References) first, and
// by the Source's own thread id (Gmail threadId, Graph conversationId) only for a message with no
// reply headers. Gmail and Outlook use the same function.

const HOUR = 60 * 60_000;
const T0 = Date.UTC(2026, 9, 1, 9);

function message(key: string, fields: Partial<ThreadingMessage> = {}): ThreadingMessage {
  return {
    key,
    messageId: `<${key}@mail.test>`,
    inReplyTo: null,
    references: [],
    sourceThreadId: null,
    sentAt: T0,
    ...fields,
  };
}

// The messages grouped by the keys they were given: each group's message keys, sorted.
function groups(keys: Map<string, string>): string[][] {
  const byThread = new Map<string, string[]>();
  for (const [message, thread] of keys) byThread.set(thread, [...(byThread.get(thread) ?? []), message]);
  return [...byThread.values()]
    .map((group) => group.sort())
    .sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
}

const root = message('a', { sourceThreadId: 'g1' });
const reply = message('b', {
  inReplyTo: '<a@mail.test>',
  references: ['<a@mail.test>'],
  sourceThreadId: 'g1',
  sentAt: T0 + HOUR,
});
const replyToReply = message('c', {
  inReplyTo: '<b@mail.test>',
  references: ['<a@mail.test>', '<b@mail.test>'],
  sourceThreadId: 'g1',
  sentAt: T0 + 2 * HOUR,
});

describe('threadMessages', () => {
  it('threads a conversation by its reply headers, keyed by its first message', () => {
    const keys = threadMessages([root, reply, replyToReply, message('other', { sentAt: T0 + HOUR })]);

    expect(groups(keys)).toEqual([['a', 'b', 'c'], ['other']]);
    expect(keys.get('c')).toBe('mid:<a@mail.test>');
  });

  it('follows In-Reply-To alone, when a client sends no References', () => {
    const bare = message('d', { inReplyTo: '<b@mail.test>', sentAt: T0 + 3 * HOUR });

    expect(groups(threadMessages([root, reply, bare]))).toEqual([['a', 'b', 'd']]);
  });

  it('puts a message with no reply headers in its Source thread', () => {
    // A reply from a client that strips reply headers, which Gmail still threaded with the rest.
    const stripped = message('e', { sourceThreadId: 'g1', sentAt: T0 + 4 * HOUR });
    const elsewhere = message('f', { sourceThreadId: 'g2', sentAt: T0 + 4 * HOUR });

    expect(groups(threadMessages([root, reply, stripped, elsewhere]))).toEqual([['a', 'b', 'e'], ['f']]);
  });

  it('lets reply headers win over the Source thread when they disagree', () => {
    // Gmail split the conversation when its subject changed; the headers still say it's one.
    const renamed = message('g', {
      inReplyTo: '<b@mail.test>',
      references: ['<a@mail.test>', '<b@mail.test>'],
      sourceThreadId: 'g9',
    });

    expect(groups(threadMessages([root, reply, renamed]))).toEqual([['a', 'b', 'g']]);
  });

  it('threads a message with no headers at all by its Source thread, or on its own', () => {
    const noHeaders = message('h', { messageId: null, sourceThreadId: 'g1', sentAt: T0 + HOUR });
    const alone = message('i', { messageId: null, sourceThreadId: null });

    const keys = threadMessages([root, noHeaders, alone]);

    expect(groups(keys)).toEqual([['a', 'h'], ['i']]);
    expect(keys.get('i')).toBe('key:i');
  });

  it('groups the same way whatever order the messages arrive in', () => {
    const all = [root, reply, replyToReply, message('x', { sentAt: T0 })];
    const expected = groups(threadMessages(all));

    expect(groups(threadMessages([...all].reverse()))).toEqual(expected);
    expect(groups(threadMessages([replyToReply, root, reply, all[3] as ThreadingMessage]))).toEqual(expected);
  });

  it('joins a parent that arrives after its replies to the thread they already have', () => {
    // The reply came first (backfill runs newest first) and was keyed then.
    const first = threadMessages([replyToReply]);
    const kept = { ...replyToReply, threadKey: first.get('c') };

    const later = threadMessages([kept, root, reply]);

    expect(groups(later)).toEqual([['a', 'b', 'c']]);
    // The thread keeps the key it already had, so nothing saved needs to change.
    expect(later.get('a')).toBe(first.get('c'));
  });

  it('merges two threads a late message bridges, keeping the older thread’s key', () => {
    const old = { ...root, threadKey: 'mid:<a@mail.test>' };
    // A reply that only named "b" was keyed on its own before "b" arrived.
    const orphan = message('d', {
      inReplyTo: '<b@mail.test>',
      sentAt: T0 + 3 * HOUR,
      threadKey: 'mid:<b@mail.test>',
    });

    const keys = threadMessages([old, orphan, reply]);

    expect(groups(keys)).toEqual([['a', 'b', 'd']]);
    expect(keys.get('d')).toBe('mid:<a@mail.test>');
  });
});

describe('message ids', () => {
  it('reads the ids from References and In-Reply-To, however they are spaced or folded', () => {
    expect(parseMessageIds('<a@x.test>\r\n <b@x.test><c@x.test>')).toEqual([
      '<a@x.test>',
      '<b@x.test>',
      '<c@x.test>',
    ]);
    expect(parseMessageIds('')).toEqual([]);
    expect(parseMessageIds('garbage')).toEqual([]);
  });

  it('normalises a Message-ID, tolerating missing angle brackets and stray spaces', () => {
    expect(normaliseMessageId(' <A1@Mail.Test> ')).toBe('<A1@Mail.Test>');
    expect(normaliseMessageId('a1@mail.test')).toBe('<a1@mail.test>');
    expect(normaliseMessageId('')).toBeNull();
    expect(normaliseMessageId(null)).toBeNull();
  });
});
