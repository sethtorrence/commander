import type { CoreItemStoreRequest } from '@commander/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createItemStoreChannel } from './item-store-channel';

const activityEntry = {
  id: 1,
  at: 1,
  by: { kind: 'user' },
  action: 'create',
  itemId: 'todo-1',
  otherItemId: null,
  why: null,
  causedBy: null,
  undoes: null,
  changes: [],
};

function channel(timeoutMs = 1000) {
  const sent: CoreItemStoreRequest[] = [];
  const itemStore = createItemStoreChannel((message) => sent.push(message), { timeoutMs });
  return { itemStore, sent };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the Item store channel in the main process', () => {
  it('relays a valid request to the Core and resolves with its reply', async () => {
    const { itemStore, sent } = channel();
    const reply = itemStore.request({ op: 'record', action: { type: 'delete', itemId: 'todo-1' } });

    expect(sent).toEqual([
      {
        type: 'item-store-request',
        id: 1,
        request: { op: 'record', action: { type: 'delete', itemId: 'todo-1' } },
      },
    ]);
    expect(
      itemStore.settle({ type: 'item-store-reply', id: 1, response: { ok: true, result: activityEntry } }),
    ).toBe(true);
    await expect(reply).resolves.toEqual({ ok: true, result: activityEntry });
  });

  it('rejects a malformed request from the window without bothering the Core', async () => {
    const { itemStore, sent } = channel();

    await expect(itemStore.request({ op: 'query', query: { limit: -5 } })).resolves.toMatchObject({
      ok: false,
    });
    await expect(itemStore.request({ op: 'saveFromSource', batch: {} })).resolves.toMatchObject({
      ok: false,
    });
    expect(sent).toEqual([]);
  });

  it('passes on an error the Core reports', async () => {
    const { itemStore } = channel();
    const reply = itemStore.request({ op: 'get', itemId: 'x' });
    itemStore.settle({ type: 'item-store-reply', id: 1, response: { ok: false, error: 'No Item x' } });

    await expect(reply).resolves.toEqual({ ok: false, error: 'No Item x' });
  });

  it('refuses a reply whose result does not fit the request', async () => {
    const { itemStore } = channel();
    const reply = itemStore.request({ op: 'query' });
    itemStore.settle({ type: 'item-store-reply', id: 1, response: { ok: true, result: [{ title: 42 }] } });

    await expect(reply).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/malformed/i) });
  });

  it('matches replies to requests by id', async () => {
    const { itemStore } = channel();
    const first = itemStore.request({ op: 'get', itemId: 'a' });
    const second = itemStore.request({ op: 'get', itemId: 'b' });
    itemStore.settle({ type: 'item-store-reply', id: 2, response: { ok: false, error: 'second' } });
    itemStore.settle({ type: 'item-store-reply', id: 1, response: { ok: false, error: 'first' } });

    await expect(first).resolves.toEqual({ ok: false, error: 'first' });
    await expect(second).resolves.toEqual({ ok: false, error: 'second' });
  });

  it('gives up when the Core does not answer in time', async () => {
    vi.useFakeTimers();
    const { itemStore } = channel(500);
    const reply = itemStore.request({ op: 'query' });
    vi.advanceTimersByTime(500);

    await expect(reply).resolves.toEqual({ ok: false, error: 'The Core did not answer in time' });
  });

  it('leaves other Core messages to other handlers', () => {
    const { itemStore } = channel();

    expect(itemStore.settle({ type: 'heartbeat', beats: 1, at: 1 })).toBe(false);
  });
});
