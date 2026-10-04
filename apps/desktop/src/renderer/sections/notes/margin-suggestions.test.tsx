// @vitest-environment jsdom
import type { Gate } from '@commander/core/src/autonomy/gate';
import type { ItemStore } from '@commander/core/src/item-store';
import type { Proposal } from '@commander/domain';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AutonomyClient } from '../ares/activity';
import { openTestGate } from '../ares/test-gate';
import { MarginCards } from './MarginCards';
import { type MarginSuggestion, useMarginSuggestions } from './margin-suggestions';

// Ares's suggestions in the margin of a Daily Note: the pending "Suggest Todos" proposals on the
// Blocks shown, from a real gate on a temporary database, reached as the window reaches it.

let store: ItemStore;
let gate: Gate;
let client: AutonomyClient;
let close: () => void;
let block: string;
let listeners: (() => void)[];

const onAresActivity = (listener: () => void) => {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((other) => other !== listener);
  };
};

const suggestTodo = (itemId: string, title: string, confidence: number): Proposal => ({
  actionKind: 'organise',
  action: 'suggest-todos',
  section: 'notes',
  itemId,
  itemActions: [
    {
      type: 'create',
      item: { kind: 'todo', title, detail: { kind: 'todo', origin: 'ares', dueOn: null, backedBy: null } },
    },
    { type: 'link', from: { step: 0 }, linkType: 'made-from', to: itemId },
  ],
  confidence,
  reason: 'You wrote “need to send Dana the Q3 numbers” in your Daily Note.',
});

beforeEach(() => {
  ({ store, gate, client, close } = openTestGate());
  listeners = [];
  gate.registerAction({ action: 'suggest-todos', actionKind: 'organise', name: 'Suggest Todos' });
  const note = store.ensureDailyNote('2026-10-03', { by: { kind: 'user' } }).id;
  const text = 'need to send Dana the Q3 numbers';
  block = store.record(
    {
      type: 'create',
      item: {
        kind: 'block',
        title: text,
        detail: { kind: 'block', dailyNoteId: note, parentId: null, position: 'a0', text, folded: false },
      },
    },
    { by: { kind: 'user' } },
  ).itemId;
});

afterEach(() => {
  cleanup();
  close();
});

const aresTodos = () =>
  store
    .query({ kinds: ['todo'] })
    .filter((todo) => todo.detail?.kind === 'todo' && todo.detail.origin === 'ares');

describe('useMarginSuggestions', () => {
  it('lists the suggestions waiting on Blocks, by Block, and catches up when Ares suggests more', async () => {
    gate.propose(suggestTodo(block, 'Send Dana the Q3 numbers', 0.5));
    const { result } = renderHook(() => useMarginSuggestions(client, onAresActivity, true));
    await waitFor(() =>
      expect(result.current.byBlock.get(block)).toEqual([
        expect.objectContaining({ title: 'Send Dana the Q3 numbers', blockId: block }),
      ]),
    );

    // Ares is sure, and Organise is at Auto when sure: done, so nothing waits in the margin.
    gate.propose(suggestTodo(block, 'Send Dana the numbers today', 0.95));
    act(() => {
      for (const listener of listeners) listener();
    });
    await waitFor(() => expect(result.current.byBlock.get(block)).toHaveLength(1));
  });

  it('adds a suggestion’s Todo, or dismisses it for good', async () => {
    gate.propose(suggestTodo(block, 'Send Dana the Q3 numbers', 0.5));
    const { result } = renderHook(() => useMarginSuggestions(client, onAresActivity, true));
    await waitFor(() => expect(result.current.byBlock.size).toBe(1));
    const [suggestion] = result.current.byBlock.get(block) as MarginSuggestion[];

    await act(() => result.current.add(suggestion?.id as number));
    expect(aresTodos().map((todo) => todo.title)).toEqual(['Send Dana the Q3 numbers']);
    await waitFor(() => expect(result.current.byBlock.size).toBe(0));

    gate.propose(suggestTodo(block, 'Call Dana', 0.5));
    act(() => {
      for (const listener of listeners) listener();
    });
    await waitFor(() => expect(result.current.byBlock.size).toBe(1));
    await act(() => result.current.dismiss(result.current.byBlock.get(block)?.[0]?.id as number));
    expect(gate.activity({ statuses: ['dismissed'] })).toHaveLength(1);
    await waitFor(() => expect(result.current.byBlock.size).toBe(0));
  });
});

describe('a margin card', () => {
  it('shows the suggested Todo and why, with Add and Dismiss', async () => {
    const added: number[] = [];
    const dismissed: number[] = [];
    render(
      <div id="day-2026-10-03">
        <div data-block={block}>need to send Dana the Q3 numbers</div>
        <MarginCards
          day="2026-10-03"
          suggestions={[
            {
              id: 7,
              blockId: block,
              title: 'Send Dana the Q3 numbers',
              reason: 'You wrote it.',
              source: 'need to send Dana the Q3 numbers',
            },
          ]}
          onAdd={(id) => added.push(id)}
          onDismiss={(id) => dismissed.push(id)}
        />
      </div>,
    );
    const card = screen.getByRole('group', { name: 'Suggested by Ares: Send Dana the Q3 numbers' });
    expect(card.textContent).toContain('Todo: Send Dana the Q3 numbers');
    expect(card.textContent).toContain('You wrote it.');
    fireEvent.click(within(card).getByRole('button', { name: 'Add' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Dismiss' }));
    expect(added).toEqual([7]);
    expect(dismissed).toEqual([7]);
  });

  it('shows Ares’s words as text only: a link only if the Block had it, never an image', () => {
    const { container } = render(
      <MarginCards
        day="2026-10-03"
        suggestions={[
          {
            id: 8,
            blockId: block,
            title: 'Read https://acme.test/runbook, not https://evil.test/x ![p](https://evil.test/p.png)',
            reason: 'You wrote “read https://acme.test/runbook”.',
            source: 'read https://acme.test/runbook',
          },
        ]}
        onAdd={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      'https://acme.test/runbook',
      'https://acme.test/runbook',
    ]);
    expect(container.querySelector('img, [src]')).toBeNull();
    expect(container.textContent).toContain('https://evil.test/x');
  });
});
