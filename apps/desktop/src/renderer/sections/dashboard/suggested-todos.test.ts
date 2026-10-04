import type { AresActivity, Ranking } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { suggestedTodoOf, withSuggestions } from './suggested-todos';

const AT = new Date(2026, 9, 3, 14, 2).getTime();

function pending(overrides: Partial<AresActivity> = {}): AresActivity {
  return {
    id: 12,
    at: AT,
    actionKind: 'organise',
    action: 'suggest-todos',
    section: 'notes',
    itemId: 'block-1',
    itemActions: [
      {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'Book flights for the offsite',
          filing: { projectId: 'p-lt', filedBy: 'inherited' },
          detail: { kind: 'todo', origin: 'ares', dueOn: null, backedBy: null },
        },
      },
      { type: 'link', from: { step: 0 }, linkType: 'made-from', to: 'block-1' },
    ],
    confidence: 0.5,
    reason: 'You wrote “maybe book flights for the offsite” in your Daily Note.',
    causedBy: null,
    chained: false,
    decision: 'ask',
    status: 'pending',
    settledAt: null,
    entryIds: [],
    name: 'Suggest Todos',
    item: {
      id: 'block-1',
      kind: 'block',
      title: 'maybe book flights for the offsite',
      source: null,
      deletedAt: null,
    },
    cause: null,
    undoable: false,
    ...overrides,
  } as AresActivity;
}

describe('suggestedTodoOf', () => {
  it('makes a pending Suggest Todos suggestion the Todo it would add, under an id of its own', () => {
    expect(suggestedTodoOf(pending())).toEqual({
      item: expect.objectContaining({
        id: 'suggestion:12',
        kind: 'todo',
        title: 'Book flights for the offsite',
        status: 'open',
        filing: { projectId: 'p-lt', filedBy: 'inherited' },
        detail: { kind: 'todo', origin: 'ares', dueOn: null, backedBy: null },
      }),
      suggestion: {
        proposalId: 12,
        blockId: 'block-1',
        reason: 'You wrote “maybe book flights for the offsite” in your Daily Note.',
        source: 'maybe book flights for the offsite',
      },
    });
  });

  it('leaves out anything else: settled suggestions, other actions, no Todo to add', () => {
    expect(suggestedTodoOf(pending({ status: 'dismissed' }))).toBeNull();
    expect(suggestedTodoOf(pending({ action: 'file-projects' }))).toBeNull();
    expect(
      suggestedTodoOf(
        pending({ itemActions: [{ type: 'update', itemId: 'block-1', changes: { title: 'x' } }] }),
      ),
    ).toBeNull();
  });
});

describe('withSuggestions', () => {
  const ranked: Ranking[] = [
    { itemId: 'a', band: 'now', rank: 1, reason: 'Urgent' },
    { itemId: 'b', band: 'today', rank: 1, reason: 'Due today' },
    { itemId: 'suggestion:7', band: 'today', rank: 2, reason: 'Prices jump next week' },
  ];
  const suggested = (id: number) =>
    suggestedTodoOf(pending({ id })) as NonNullable<ReturnType<typeof suggestedTodoOf>>;

  it('puts the suggestions no one ranked at the end of Today, with why Ares suggested them', () => {
    expect(withSuggestions(ranked, [suggested(7), suggested(9)], new Set())).toEqual([
      ...ranked,
      {
        itemId: 'suggestion:9',
        band: 'today',
        rank: 3,
        reason: 'You wrote “maybe book flights for the offsite” in your Daily Note.',
      },
    ]);
  });

  it('leaves off one Ares put in no band', () => {
    expect(withSuggestions(ranked, [suggested(9)], new Set(['suggestion:9']))).toEqual(ranked);
  });
});
