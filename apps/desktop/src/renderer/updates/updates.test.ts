import type { QueuedLine, UpdateViewLine } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { acceptLabel, foldedSummary, lineStatus, openTarget } from './updates';

const queued = (overrides: Partial<QueuedLine> = {}): QueuedLine => ({
  id: 1,
  group: 'decision',
  mergeKey: 'suggestions:suggest-todos',
  about: {
    kind: 'suggestions',
    action: 'suggest-todos',
    name: 'Suggest Todos',
    actionKind: 'organise',
    proposalIds: [4],
  },
  itemIds: ['block-1'],
  section: 'notes',
  importance: 0.6,
  createdAt: 1,
  updatedAt: 1,
  expiresAt: null,
  snoozedUntil: null,
  status: 'queued',
  settledAt: null,
  ...overrides,
});

const line = (overrides: Partial<QueuedLine> = {}, extra: Partial<UpdateViewLine> = {}): UpdateViewLine => {
  const q = queued(overrides);
  return {
    queuedId: q.id,
    group: q.group,
    kind: q.about.kind,
    text: 'Suggest Todos: one suggestion I wasn’t sure about.',
    itemIds: q.itemIds,
    section: q.section,
    sources: [],
    folded: false,
    fresh: true,
    queued: q,
    ...extra,
  };
};

describe('accepting in place', () => {
  it('offers Accept on one suggestion, Accept all on several Organise ones, and nothing on Act for you ones', () => {
    expect(acceptLabel(line())).toBe('Accept');
    const several = { kind: 'suggestions' as const, action: 'a', name: 'A', proposalIds: [1, 2, 3] };
    expect(acceptLabel(line({ about: { ...several, actionKind: 'organise' } }))).toBe('Accept all 3');
    expect(acceptLabel(line({ about: { ...several, actionKind: 'act-for-you' } }))).toBeNull();
  });

  it('offers to just do them for an Autonomy change, and nothing for a line with nothing to accept', () => {
    expect(
      acceptLabel(
        line({
          about: {
            kind: 'autonomy-change',
            action: 'a',
            name: 'A',
            actionKind: 'organise',
            section: null,
            from: 'ask',
            to: 'auto-when-sure',
            accepted: 20,
            lastProposalId: 9,
          },
        }),
      ),
    ).toBe('Yes, just do them');
    expect(
      acceptLabel(line({ about: { kind: 'cap-warning', month: '2026-10', spentUsd: 8, capUsd: 10 } })),
    ).toBeNull();
  });

  it('offers nothing on a line already acted on', () => {
    expect(acceptLabel(line({ status: 'done' }))).toBeNull();
    expect(acceptLabel(line({}, { queued: null }))).toBeNull();
  });
});

describe('where Open goes', () => {
  it('to the one Item a line is about, in its Section', () => {
    expect(openTarget(line())).toEqual({ kind: 'item', sectionId: 'notes', itemId: 'block-1' });
  });

  it('to Ares’s activity page for several suggestions, and to Settings for the cap or an Autonomy change', () => {
    const several = {
      kind: 'suggestions' as const,
      action: 'a',
      name: 'A',
      actionKind: 'organise' as const,
      proposalIds: [1, 2],
    };
    expect(openTarget(line({ about: several, itemIds: ['b1', 'b2'] }))).toEqual({
      kind: 'section',
      sectionId: 'ares',
    });
    expect(
      openTarget(
        line({
          about: { kind: 'cap-warning', month: '2026-10', spentUsd: 8, capUsd: 10 },
          itemIds: [],
          section: 'ares',
        }),
      ),
    ).toEqual({ kind: 'settings' });
  });

  it('to the Section of several warned Items', () => {
    expect(
      openTarget(
        line({
          about: { kind: 'injection-warnings', entryIds: [1, 2] },
          itemIds: ['i1', 'i2'],
          section: 'linear',
        }),
      ),
    ).toEqual({ kind: 'section', sectionId: 'linear' });
  });
});

describe('the folded smaller things', () => {
  it('counts them, grouped by Section', () => {
    const lines = [
      line({ id: 1 }, { folded: false }),
      line({ id: 2, section: 'notes' }, { folded: true }),
      line({ id: 3, section: 'linear' }, { folded: true }),
      line({ id: 4, section: 'notes' }, { folded: true }),
    ];
    expect(foldedSummary(lines)).toEqual({
      count: 3,
      text: 'and 3 smaller things',
      bySection: [
        { section: 'notes', name: 'Notes', count: 2 },
        { section: 'linear', name: 'Linear', count: 1 },
      ],
    });
    expect(foldedSummary([line({ id: 1 }, { folded: true })]).text).toBe('and 1 smaller thing');
  });
});

describe('where a line stands', () => {
  it('says what became of it, and when a snooze ends', () => {
    const at = new Date(2026, 9, 3, 10, 0).getTime();
    expect(lineStatus(line(), at)).toBeNull();
    expect(lineStatus(line({ status: 'done' }), at)).toBe('Done');
    expect(lineStatus(line({ status: 'resolved' }), at)).toBe('Done');
    expect(lineStatus(line({ status: 'dismissed' }), at)).toBe('Dismissed');
    expect(lineStatus(line({ status: 'expired' }), at)).toBe('No longer needed');
    expect(lineStatus(line({ snoozedUntil: new Date(2026, 9, 3, 13, 0).getTime() }), at)).toBe(
      'Snoozed till 13:00',
    );
    expect(lineStatus(line({ snoozedUntil: new Date(2026, 9, 4, 9, 0).getTime() }), at)).toBe(
      'Snoozed till tomorrow 09:00',
    );
  });
});
