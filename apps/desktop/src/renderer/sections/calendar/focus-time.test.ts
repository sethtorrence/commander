import type { AresActivity } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { BLOCK_TIME_FOR_TODOS, focusBlockOf, focusTimeOf, withSuggestionDays } from './focus-time';

// The Calendar Section's Focus time panel reads Ares's focus block suggestions from the gate.

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 9, 5, 8);

let next = 0;
function row(start: number, extra: Partial<AresActivity> = {}): AresActivity {
  next += 1;
  return {
    id: next,
    at: NOW,
    actionKind: 'tidy-sources',
    action: BLOCK_TIME_FOR_TODOS,
    section: 'calendar',
    itemId: `todo-${next}`,
    itemActions: [
      {
        type: 'create-event',
        event: {
          kind: 'focus-block',
          account: 'google:1',
          title: `Focus: Todo ${next}`,
          start: { at: start, timeZone: 'Europe/London', date: null },
          end: { at: start + 2 * HOUR, timeZone: 'Europe/London', date: null },
          allDay: false,
          attendees: [],
          guestsToFill: [],
        },
      },
      { type: 'link', from: { step: 0 }, linkType: 'made-from', to: `todo-${next}` },
    ],
    confidence: 0.8,
    reason: 'You’re free Thursday 9–11.',
    causedBy: null,
    chained: false,
    conversation: null,
    decision: 'ask',
    status: 'pending',
    settledAt: null,
    entryIds: [],
    name: 'Block time for Todos',
    item: { id: `todo-${next}`, kind: 'todo', title: `Todo ${next}`, source: null, deletedAt: null },
    cause: null,
    undoable: false,
    ...extra,
  };
}

describe('focus time', () => {
  it('reads a suggestion as the focus block it would make', () => {
    const suggestion = row(NOW + 24 * HOUR);
    expect(focusBlockOf(suggestion)).toEqual({
      id: suggestion.id,
      todoId: suggestion.itemId,
      todoTitle: suggestion.item?.title,
      title: `Focus: ${suggestion.item?.title}`,
      start: NOW + 24 * HOUR,
      end: NOW + 26 * HOUR,
      reason: 'You’re free Thursday 9–11.',
    });
    expect(focusBlockOf({ ...suggestion, action: 'suggest-todos' })).toBeNull();
  });

  it('lists waiting suggestions earliest first, and the accepted blocks still to come that can be undone', () => {
    const later = row(NOW + 48 * HOUR);
    const sooner = row(NOW + 24 * HOUR);
    const dismissed = row(NOW + 30 * HOUR, { status: 'dismissed' });
    const accepted = row(NOW + 72 * HOUR, { status: 'accepted', undoable: true, entryIds: [1, 2] });
    const undone = row(NOW + 80 * HOUR, { status: 'accepted', undoable: false, entryIds: [3, 4] });
    const past = row(NOW - 5 * HOUR, { status: 'accepted', undoable: true, entryIds: [5, 6] });
    const { suggestions, planned } = focusTimeOf([later, sooner, dismissed, accepted, undone, past], NOW);
    expect(suggestions.map((each) => each.id)).toEqual([sooner.id, later.id]);
    expect(planned.map((each) => each.id)).toEqual([accepted.id]);
  });
});

describe('the Agenda with focus suggestions', () => {
  it('lists the days Ares suggests focus blocks on, even with no events, within the days shown', () => {
    const block = focusBlockOf(row(NOW)) as NonNullable<ReturnType<typeof focusBlockOf>>;
    const agenda = [
      { day: '2026-10-04', title: 'Today', entries: [] },
      { day: '2026-10-07', title: 'Wednesday 7 October', entries: [] },
    ];
    const byDay = new Map([
      ['2026-10-05', [block]],
      ['2026-10-07', [block]],
      ['2026-12-01', [block]],
    ]);
    expect(
      withSuggestionDays(agenda, byDay, { today: '2026-10-04', from: '2026-10-04', last: '2026-11-02' }).map(
        (day) => day.day,
      ),
    ).toEqual(['2026-10-04', '2026-10-05', '2026-10-07']);
  });
});
