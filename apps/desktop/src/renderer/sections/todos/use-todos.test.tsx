// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestItemStore } from './test-item-store';
import { describeEntry, type Todos, todosIn } from './todos';
import { useTodos } from './use-todos';

let todos: Todos;
let close: () => void;

beforeEach(() => {
  const opened = openTestItemStore();
  close = opened.close;
  todos = todosIn(opened.client);
});

afterEach(() => {
  cleanup();
  close();
});

async function renderTodos() {
  const hook = renderHook(() => useTodos(todos));
  await waitFor(() => expect(hook.result.current.list).toEqual([]));
  return hook;
}

const titles = (list: { title: string; status: string }[] | null) =>
  list?.map((todo) => (todo.status === 'done' ? `[x] ${todo.title}` : todo.title));

describe('useTodos', () => {
  it('lists a Todo once added, selects it and shows its history', async () => {
    const { result } = await renderTodos();

    await act(() => result.current.add('Book the dentist'));

    await waitFor(() => expect(result.current.selected?.title).toBe('Book the dentist'));
    await waitFor(() =>
      expect(result.current.history.map((entry) => describeEntry(entry, result.current.history))).toEqual([
        'Added by you',
      ]),
    );
  });

  it('ticks the selected Todo, and unticks it when it is already ticked', async () => {
    const { result } = await renderTodos();
    await act(() => result.current.add('Renew passport'));
    await waitFor(() => expect(result.current.selected?.title).toBe('Renew passport'));

    await act(() => result.current.toggle());
    await waitFor(() => expect(titles(result.current.list)).toEqual(['[x] Renew passport']));

    await act(() => result.current.toggle());
    await waitFor(() => expect(titles(result.current.list)).toEqual(['Renew passport']));
  });

  it('undoes the changes made here one at a time, newest first', async () => {
    const { result } = await renderTodos();
    await act(() => result.current.add('Water the plants'));
    await waitFor(() => expect(result.current.selected?.title).toBe('Water the plants'));
    await act(() => result.current.toggle());
    await waitFor(() => expect(titles(result.current.list)).toEqual(['[x] Water the plants']));

    await act(() => result.current.undo());
    await waitFor(() => expect(titles(result.current.list)).toEqual(['Water the plants']));

    // Undoing the add takes the Todo away again.
    await act(() => result.current.undo());
    await waitFor(() => expect(result.current.list).toEqual([]));
  });

  it('moves the selection up and down the list, stopping at the ends', async () => {
    const { result } = await renderTodos();
    for (const title of ['First', 'Second']) {
      await act(() => result.current.add(title));
      await waitFor(() => expect(result.current.selected?.title).toBe(title));
    }

    act(() => result.current.moveSelection(-1));
    expect(result.current.selected?.title).toBe('First');
    act(() => result.current.moveSelection(-1));
    expect(result.current.selected?.title).toBe('First');
    act(() => result.current.moveSelection(1));
    expect(result.current.selected?.title).toBe('Second');
  });

  it('ignores a blank title', async () => {
    const { result } = await renderTodos();

    await expect(act(() => result.current.add('   '))).resolves.toBe(false);
    expect(result.current.list).toEqual([]);
  });
});
