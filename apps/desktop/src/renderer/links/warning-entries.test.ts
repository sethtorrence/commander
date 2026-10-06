import type { ActivityEntry } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { describeWarningEntry } from './warning-entries';

// An Item's history words Ares's warnings and refusals, and the User's Not an instruction (#201).

const entry = (id: number, overrides: Partial<ActivityEntry>): ActivityEntry => ({
  id,
  at: 0,
  by: { kind: 'ares' },
  action: 'update',
  itemId: 'mail-1',
  otherItemId: null,
  otherProjectId: null,
  why: null,
  causedBy: null,
  undoes: null,
  changes: [],
  ...overrides,
});

describe('describeWarningEntry', () => {
  it('words warnings, refusals, Not an instruction and its undoing; nothing else', () => {
    const why = 'Ares skipped Dana Kim’s email: it holds what looks like one of your keys or sign-in tokens.';
    const cleared = entry(2, {
      by: { kind: 'user' },
      action: 'correction',
      why: 'Not an instruction aimed at Ares',
    });
    const history = [cleared];
    expect(describeWarningEntry(entry(1, { action: 'refusal', why }), history)).toBe(why);
    expect(describeWarningEntry(entry(1, { action: 'injection-warning', why: 'This email…' }), history)).toBe(
      'This email…',
    );
    expect(describeWarningEntry(cleared, history)).toBe('Marked not an instruction by you');
    expect(describeWarningEntry(entry(3, { by: { kind: 'user' }, action: 'undo', undoes: 2 }), history)).toBe(
      'Not an instruction undone by you: the mark is back',
    );
    expect(describeWarningEntry(entry(4, { action: 'update' }), history)).toBeNull();
    expect(
      describeWarningEntry(entry(5, { by: { kind: 'user' }, action: 'correction' }), history),
    ).toBeNull();
  });
});
