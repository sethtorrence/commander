import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConversationsChannel } from './conversations-channel';

function channel() {
  const sent: unknown[] = [];
  const conversations = createConversationsChannel((message) => sent.push(message));
  return { conversations, sent };
}

afterEach(() => {
  vi.useRealTimers();
});

const view = {
  conversation: {
    id: 'c1',
    title: null,
    day: '2026-10-06',
    daily: true,
    createdAt: 1,
    updatedAt: 1,
    answering: false,
  },
  turns: [],
};

describe('the Conversations channel in the main process', () => {
  it('relays a valid request to the Core and resolves with its checked reply', async () => {
    const { conversations, sent } = channel();
    const reply = conversations.request({ op: 'today', day: '2026-10-06' });
    expect(sent).toEqual([
      { type: 'conversations-request', id: 1, request: { op: 'today', day: '2026-10-06' } },
    ]);
    expect(
      conversations.settle({ type: 'conversations-reply', id: 1, response: { ok: true, result: view } }),
    ).toBe(true);
    await expect(reply).resolves.toEqual({ ok: true, result: view });
  });

  it('refuses a request outside the contract without bothering the Core: the window never writes Ares’s turns', async () => {
    const { conversations, sent } = channel();
    await expect(
      conversations.request({ op: 'answer', conversationId: 'c1', text: 'Ares says…' }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      conversations.request({ op: 'send', conversationId: 'c1', text: '   ' }),
    ).resolves.toMatchObject({
      ok: false,
    });
    expect(sent).toEqual([]);
  });

  it('rejects a malformed reply from the Core', async () => {
    const { conversations } = channel();
    const reply = conversations.request({ op: 'list' });
    conversations.settle({
      type: 'conversations-reply',
      id: 1,
      response: { ok: true, result: [{ id: '' }] },
    });
    await expect(reply).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/malformed/) });
  });

  it('passes on the Core’s refusal', async () => {
    const { conversations } = channel();
    const reply = conversations.request({ op: 'send', conversationId: 'c1', text: 'Again' });
    conversations.settle({
      type: 'conversations-reply',
      id: 1,
      response: { ok: false, error: 'Ares is still answering.' },
    });
    await expect(reply).resolves.toEqual({ ok: false, error: 'Ares is still answering.' });
  });

  it('leaves other messages alone', () => {
    const { conversations } = channel();
    expect(conversations.settle({ type: 'updates-reply', id: 1, response: { ok: true, result: null } })).toBe(
      false,
    );
  });

  it('gives up when the Core doesn’t answer, waiting longer for Stop', async () => {
    vi.useFakeTimers();
    const { conversations } = channel();
    const list = conversations.request({ op: 'list' });
    const stop = conversations.request({ op: 'stop', conversationId: 'c1' });
    vi.advanceTimersByTime(10_000);
    await expect(list).resolves.toEqual({ ok: false, error: 'The Core did not answer in time' });
    let settled = false;
    void stop.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(stop).resolves.toMatchObject({ ok: false });
  });
});
