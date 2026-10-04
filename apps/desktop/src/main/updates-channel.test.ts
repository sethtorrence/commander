import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpdatesChannel } from './updates-channel';

function channel() {
  const sent: unknown[] = [];
  const updates = createUpdatesChannel((message) => sent.push(message));
  return { updates, sent };
}

afterEach(() => {
  vi.useRealTimers();
});

const state = { queued: 3, presence: { state: 'active', since: 1 } };

describe('the Updates channel in the main process', () => {
  it('relays a valid request to the Core and resolves with its checked reply', async () => {
    const { updates, sent } = channel();
    const reply = updates.request({ op: 'state' });
    expect(sent).toEqual([{ type: 'updates-request', id: 1, request: { op: 'state' } }]);
    expect(updates.settle({ type: 'updates-reply', id: 1, response: { ok: true, result: state } })).toBe(
      true,
    );
    await expect(reply).resolves.toEqual({ ok: true, result: state });
  });

  it('refuses a request outside the contract without bothering the Core: the window never enqueues', async () => {
    const { updates, sent } = channel();
    await expect(updates.request({ op: 'enqueue', line: {} })).resolves.toMatchObject({ ok: false });
    expect(sent).toEqual([]);
  });

  it('rejects a malformed reply from the Core', async () => {
    const { updates } = channel();
    const reply = updates.request({ op: 'state' });
    updates.settle({ type: 'updates-reply', id: 1, response: { ok: true, result: { queued: -1 } } });
    await expect(reply).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/malformed/) });
  });

  it('leaves other messages alone', () => {
    const { updates } = channel();
    expect(updates.settle({ type: 'models-reply', id: 1, response: { ok: true, result: null } })).toBe(false);
  });

  it('gives up when the Core doesn’t answer, waiting longer for an Update Ares is putting together', async () => {
    vi.useFakeTimers();
    const { updates } = channel();
    const state = updates.request({ op: 'state' });
    const update = updates.request({ op: 'run-skill', skill: 'update' });
    vi.advanceTimersByTime(10_000);
    await expect(state).resolves.toEqual({ ok: false, error: 'The Core did not answer in time' });
    let settled = false;
    void update.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(update).resolves.toMatchObject({ ok: false });
  });
});
