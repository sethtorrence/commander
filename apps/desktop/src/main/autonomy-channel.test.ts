import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutonomyChannels } from './autonomy-channel';

const state = {
  settings: {
    everywhere: { organise: 'auto-when-sure', 'tidy-sources': 'ask', 'act-for-you': 'ask', delete: 'off' },
    sections: {},
    actions: {},
  },
  actions: [],
};

function channels(timeoutMs = 1000) {
  const sent: unknown[] = [];
  return { ...createAutonomyChannels((message) => sent.push(message), { timeoutMs }), sent };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the autonomy channels in the main process', () => {
  it('relay a window request to the Core and resolve with its checked reply', async () => {
    const { window, sent } = channels();
    const reply = window.request({ op: 'settings' });
    expect(sent).toEqual([{ type: 'autonomy-request', id: 1, request: { op: 'settings' } }]);
    expect(window.settle({ type: 'autonomy-reply', id: 1, response: { ok: true, result: state } })).toBe(
      true,
    );
    await expect(reply).resolves.toEqual({ ok: true, result: state });
  });

  it('refuse a proposal from the window without bothering the Core', async () => {
    const { window, sent } = channels();
    await expect(window.request({ op: 'propose', proposal: {} })).resolves.toMatchObject({ ok: false });
    await expect(
      window.request({
        op: 'set-level',
        target: { scope: 'everywhere', actionKind: 'delete' },
        level: 'always',
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(sent).toEqual([]);
  });

  it('reject a malformed reply from the Core', async () => {
    const { window } = channels();
    const reply = window.request({ op: 'settings' });
    window.settle({
      type: 'autonomy-reply',
      id: 1,
      response: { ok: true, result: { settings: 'all auto' } },
    });
    await expect(reply).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/malformed/) });
  });

  it('keep test requests apart from window requests', async () => {
    const { window, test, sent } = channels();
    const fromTest = test.request({
      op: 'register-action',
      action: { action: 'suggest-todos', actionKind: 'organise', name: 'Suggest Todos' },
    });
    expect(sent).toMatchObject([{ type: 'autonomy-test-request', id: 1 }]);
    expect(window.settle({ type: 'autonomy-test-reply', id: 1, response: { ok: true, result: null } })).toBe(
      false,
    );
    expect(test.settle({ type: 'autonomy-test-reply', id: 1, response: { ok: true, result: null } })).toBe(
      true,
    );
    await expect(fromTest).resolves.toEqual({ ok: true, result: null });
  });

  it('give up when the Core does not answer in time', async () => {
    vi.useFakeTimers();
    const { window } = channels(50);
    const reply = window.request({ op: 'settings' });
    vi.advanceTimersByTime(60);
    await expect(reply).resolves.toEqual({ ok: false, error: 'The Core did not answer in time' });
  });
});
