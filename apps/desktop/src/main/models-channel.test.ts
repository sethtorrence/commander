import { type CoreModelsRequest, defaultModelSettings } from '@commander/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelsChannel } from './models-channel';

function channel() {
  const sent: CoreModelsRequest[] = [];
  const models = createModelsChannel((message) => sent.push(message));
  return { models, sent };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the models channel in the main process', () => {
  it('relays a valid request to the Core and resolves with its checked reply', async () => {
    const { models, sent } = channel();
    const reply = models.request({ op: 'settings' });

    expect(sent).toEqual([{ type: 'models-request', id: 1, request: { op: 'settings' } }]);
    expect(
      models.settle({ type: 'models-reply', id: 1, response: { ok: true, result: defaultModelSettings } }),
    ).toBe(true);
    await expect(reply).resolves.toEqual({ ok: true, result: defaultModelSettings });
  });

  it('refuses a request outside the contract without bothering the Core', async () => {
    const { models, sent } = channel();

    await expect(models.request({ op: 'read-key' })).resolves.toMatchObject({ ok: false });
    expect(sent).toEqual([]);
  });

  it('passes on a typed failure', async () => {
    const { models } = channel();
    const reply = models.request({ op: 'test' });

    models.settle({
      type: 'models-reply',
      id: 1,
      response: { ok: false, error: 'Over the cap', kind: 'over-cap' },
    });

    await expect(reply).resolves.toEqual({ ok: false, error: 'Over the cap', kind: 'over-cap' });
  });

  it('rejects a reply that does not fit the request', async () => {
    const { models } = channel();
    const reply = models.request({ op: 'usage' });

    models.settle({ type: 'models-reply', id: 1, response: { ok: true, result: { calls: 'many' } } });

    await expect(reply).resolves.toMatchObject({ ok: false, error: expect.stringContaining('malformed') });
  });

  it('gives Test long enough for a slow model, but not forever', async () => {
    vi.useFakeTimers();
    const { models } = channel();
    const test = models.request({ op: 'test' });
    const settings = models.request({ op: 'settings' });

    await vi.advanceTimersByTimeAsync(11_000);
    await expect(settings).resolves.toMatchObject({ ok: false, error: expect.stringContaining('in time') });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await expect(test).resolves.toMatchObject({ ok: false, error: expect.stringContaining('in time') });
  });

  it('leaves other messages alone', () => {
    expect(channel().models.settle({ type: 'heartbeat', beats: 1, at: 1 })).toBe(false);
  });
});
