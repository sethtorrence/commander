import { COMPOSE_MESSAGES } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { createComposeChannel } from './compose-channel';

// The compose channel (#138): the window's requests reach the Core only when valid, its answers reach
// the window only when they fit the request, and quitting waits for the Core to send held messages.

describe('the compose channel', () => {
  it('relays a valid request and hands back the Core’s answer', async () => {
    const sent: { id: number; request: unknown }[] = [];
    const channel = createComposeChannel((message) => sent.push(message as { id: number; request: unknown }));

    const answer = channel.request({ op: 'settings' });
    expect(sent).toEqual([{ type: COMPOSE_MESSAGES.request, id: 1, request: { op: 'settings' } }]);
    expect(
      channel.settle({
        type: COMPOSE_MESSAGES.reply,
        id: 1,
        response: { ok: true, result: { defaultAccount: null, undoSeconds: 10 } },
      }),
    ).toBe(true);
    await expect(answer).resolves.toEqual({ ok: true, result: { defaultAccount: null, undoSeconds: 10 } });
  });

  it('refuses a malformed request, and an answer that doesn’t fit it', async () => {
    const channel = createComposeChannel(() => {});
    await expect(channel.request({ op: 'send', draft: { body: '<script>' } })).resolves.toMatchObject({
      ok: false,
    });

    const answer = channel.request({ op: 'settings' });
    channel.settle({
      type: COMPOSE_MESSAGES.reply,
      id: 1,
      response: { ok: true, result: { undoSeconds: 45 } },
    });
    await expect(answer).resolves.toMatchObject({ ok: false });
  });

  it('waits for the Core to send the messages held for Undo when Commander quits', async () => {
    const sent: { type: string; id: number }[] = [];
    const channel = createComposeChannel((message) => sent.push(message as { type: string; id: number }));
    let done = false;
    const quitting = channel.sendHeld().then(() => {
      done = true;
    });

    expect(sent).toEqual([{ type: COMPOSE_MESSAGES.sendHeld, id: 1 }]);
    await Promise.resolve();
    expect(done).toBe(false);
    expect(channel.settle({ type: COMPOSE_MESSAGES.sentHeld, id: 1 })).toBe(true);
    await quitting;
    expect(done).toBe(true);
  });
});
