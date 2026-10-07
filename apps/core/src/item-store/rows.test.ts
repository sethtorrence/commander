import { itemChange } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { changesBetween, type ItemState } from './rows';

describe('changesBetween', () => {
  it('reports the Item fields that changed, in ItemState order', () => {
    const before = { title: 'Old', status: 'open' } as unknown as ItemState;
    const after = { title: 'New', status: 'done' } as unknown as ItemState;
    expect(changesBetween(before, after).map((change) => change.field)).toEqual(['title', 'status']);
  });

  it('leaves out Commander’s own fields an entry records for undo, which the window would refuse', () => {
    const before = { bucket: { bucketId: 'a', sortedBy: 'ares' } } as unknown as ItemState;
    const after = { bucket: { bucketId: 'b', sortedBy: 'user' } } as unknown as ItemState;
    const changes = changesBetween(before, after);
    expect(changes).toEqual([]);
    for (const change of changes) expect(itemChange.safeParse(change).success).toBe(true);
  });

  it('keeps an Item field changed beside one of Commander’s own', () => {
    const before = { title: 'Old', injectionWarning: { quote: 'x' } } as unknown as ItemState;
    const after = { title: 'New', injectionWarning: null } as unknown as ItemState;
    expect(changesBetween(before, after).map((change) => change.field)).toEqual(['title']);
  });
});
