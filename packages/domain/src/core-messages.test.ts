import { describe, expect, it } from 'vitest';
import { parseCoreMessage } from './core-messages';

describe('parseCoreMessage', () => {
  it('accepts a heartbeat from the core', () => {
    const result = parseCoreMessage({ type: 'heartbeat', beats: 3, at: 1_790_000_000_000 });
    expect(result).toEqual({ ok: true, message: { type: 'heartbeat', beats: 3, at: 1_790_000_000_000 } });
  });

  it('accepts word that Ares did or suggested something', () => {
    expect(parseCoreMessage({ type: 'ares-activity', at: 5 })).toEqual({
      ok: true,
      message: { type: 'ares-activity', at: 5 },
    });
  });

  it('accepts word of which Items changed', () => {
    const result = parseCoreMessage({ type: 'items-changed', itemIds: ['a', 'b'] });
    expect(result).toEqual({ ok: true, message: { type: 'items-changed', itemIds: ['a', 'b'] } });
  });

  it.each([
    ['an Items change naming no Items', { type: 'items-changed', itemIds: [] }],
    ['an Items change with an empty id', { type: 'items-changed', itemIds: [''] }],
    ['a missing beat count', { type: 'heartbeat', at: 1 }],
    ['a negative beat count', { type: 'heartbeat', beats: -1, at: 1 }],
    ['a fractional beat count', { type: 'heartbeat', beats: 1.5, at: 1 }],
    ['an unknown message type', { type: 'launch-missiles' }],
    ['something that is not an object', 'heartbeat'],
  ])('rejects %s', (_case, input) => {
    expect(parseCoreMessage(input).ok).toBe(false);
  });
});
