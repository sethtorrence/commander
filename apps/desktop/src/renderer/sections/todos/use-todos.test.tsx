// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestItemStore } from './test-item-store';
import { describeEntry, type Todos, todosIn } from './todos';
import { type TodosState, useTodos } from './use-todos';

let store: ItemStore;
let todos: Todos;
let close: () => void;

beforeEach(() => {
  const opened = openTestItemStore();
  ({ store, close } = opened);
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

type Hook = Awaited<ReturnType<typeof renderTodos>>;

async function addTodos(hook: Hook, ...titles: string[]) {
  for (const title of titles) {
    await act(() => hook.result.current.add(title));
    await waitFor(() => expect(hook.result.current.selected?.title).toBe(title));
  }
}

const titles = (todos: { title: string }[]) => todos.map((todo) => todo.title);
const described = (state: TodosState) => state.history.map((entry) => describeEntry(entry, state.history));

describe('useTodos', () => {
  it('lists a Todo once added, selects it and shows its history', async () => {
    const hook = await renderTodos();

    await addTodos(hook, 'Book the dentist');

    await waitFor(() => expect(described(hook.result.current)).toEqual(['Added by you']));
    expect(hook.result.current.openCount).toBe(1);
  });

  it('ticks the selected Todo into the Done group, and unticks it back into the open list', async () => {
    const hook = await renderTodos();
    await addTodos(hook, 'Renew passport');

    await act(() => hook.result.current.toggle());
    await waitFor(() => expect(titles(hook.result.current.done)).toEqual(['Renew passport']));
    expect(hook.result.current.open).toEqual([]);
    expect(hook.result.current.openCount).toBe(0);

    const [ticked] = hook.result.current.done;
    await act(() => hook.result.current.toggle(ticked?.id));
    await waitFor(() => expect(titles(hook.result.current.open)).toEqual(['Renew passport']));
    expect(hook.result.current.done).toEqual([]);
  });

  it('keeps the Done group collapsed until it is shown, and moves the selection over shown Todos only', async () => {
    const hook = await renderTodos();
    await addTodos(hook, 'First', 'Second', 'Third');
    act(() => hook.result.current.select(hook.result.current.open[1]?.id ?? ''));

    // Ticking the selected Todo moves the selection on to the next open one.
    await act(() => hook.result.current.toggle());
    await waitFor(() => expect(titles(hook.result.current.done)).toEqual(['Second']));
    expect(hook.result.current.doneShown).toBe(false);
    expect(hook.result.current.selected?.title).toBe('Third');

    act(() => hook.result.current.moveSelection(1));
    expect(hook.result.current.selected?.title).toBe('Third');

    act(() => hook.result.current.showDone(true));
    act(() => hook.result.current.moveSelection(1));
    expect(hook.result.current.selected?.title).toBe('Second');

    // Hiding Done again takes the selection back to the open list.
    act(() => hook.result.current.showDone(false));
    await waitFor(() => expect(hook.result.current.selected?.title).toBe('Third'));
  });

  it('opens and closes the detail pane', async () => {
    const hook = await renderTodos();
    await addTodos(hook, 'Water the plants');
    expect(hook.result.current.detailOpen).toBe(false);

    act(() => hook.result.current.setDetailOpen(true));
    expect(hook.result.current.detailOpen).toBe(true);

    act(() => hook.result.current.setDetailOpen(false));
    expect(hook.result.current.detailOpen).toBe(false);
  });

  it('renames the selected Todo, records it, and undo restores the old title', async () => {
    const hook = await renderTodos();
    await addTodos(hook, 'Book the dentist');

    await act(() => hook.result.current.rename('Book the dentist for Tuesday'));
    await waitFor(() => expect(titles(hook.result.current.open)).toEqual(['Book the dentist for Tuesday']));
    await waitFor(() =>
      expect(described(hook.result.current)).toEqual(['Title changed by you', 'Added by you']),
    );

    await act(() => hook.result.current.undo());
    await waitFor(() => expect(titles(hook.result.current.open)).toEqual(['Book the dentist']));
  });

  it('leaves the title alone when it is unchanged or blank', async () => {
    const hook = await renderTodos();
    await addTodos(hook, 'Book the dentist');

    await expect(act(() => hook.result.current.rename(' Book the dentist '))).resolves.toBe(false);
    await expect(act(() => hook.result.current.rename('  '))).resolves.toBe(false);
    await waitFor(() => expect(described(hook.result.current)).toEqual(['Added by you']));
  });

  it('deletes the selected Todo, selects the next one, and undo brings it back with its history', async () => {
    const hook = await renderTodos();
    await addTodos(hook, 'First', 'Second', 'Third');
    act(() => hook.result.current.select(hook.result.current.open[1]?.id ?? ''));

    await act(() => hook.result.current.remove());
    await waitFor(() => expect(titles(hook.result.current.open)).toEqual(['First', 'Third']));
    expect(hook.result.current.selected?.title).toBe('Third');

    await act(() => hook.result.current.undo());
    await waitFor(() => expect(titles(hook.result.current.open)).toEqual(['First', 'Second', 'Third']));
    act(() => hook.result.current.select(hook.result.current.open[1]?.id ?? ''));
    await waitFor(() =>
      expect(described(hook.result.current)).toEqual([
        'Delete undone by you',
        'Deleted by you',
        'Added by you',
      ]),
    );
  });

  it('shows the selected Todo’s Links both ways', async () => {
    const hook = await renderTodos();
    await addTodos(hook, 'Prep for the Acme call', 'Send the deck');
    const [prep, deck] = hook.result.current.open;
    store.link({ from: deck?.id ?? '', linkType: 'caused-by', to: prep?.id ?? '' }, { by: { kind: 'user' } });

    act(() => hook.result.current.select(prep?.id ?? ''));
    act(() => hook.result.current.refresh());

    await waitFor(() =>
      expect(hook.result.current.links).toMatchObject([
        { type: 'caused-by', backlink: true, other: { title: 'Send the deck' } },
      ]),
    );
  });

  it('jumps to a Todo in the Done group by showing the group and selecting it', async () => {
    const hook = await renderTodos();
    await addTodos(hook, 'First', 'Second');
    const [first] = hook.result.current.open;
    await act(() => hook.result.current.toggle(first?.id));
    await waitFor(() => expect(titles(hook.result.current.done)).toEqual(['First']));

    act(() => hook.result.current.jumpTo(first?.id ?? ''));

    expect(hook.result.current.doneShown).toBe(true);
    expect(hook.result.current.selected?.title).toBe('First');
  });

  it('undoes the changes made here one at a time, newest first', async () => {
    const hook = await renderTodos();
    await addTodos(hook, 'Water the plants');
    await act(() => hook.result.current.toggle());
    await waitFor(() => expect(titles(hook.result.current.done)).toEqual(['Water the plants']));

    await act(() => hook.result.current.undo());
    await waitFor(() => expect(titles(hook.result.current.open)).toEqual(['Water the plants']));

    // Undoing the add takes the Todo away again.
    await act(() => hook.result.current.undo());
    await waitFor(() => expect(hook.result.current.list).toEqual([]));
  });

  it('moves the selection up and down the list, stopping at the ends', async () => {
    const hook = await renderTodos();
    await addTodos(hook, 'First', 'Second');

    act(() => hook.result.current.moveSelection(-1));
    expect(hook.result.current.selected?.title).toBe('First');
    act(() => hook.result.current.moveSelection(-1));
    expect(hook.result.current.selected?.title).toBe('First');
    act(() => hook.result.current.moveSelection(1));
    expect(hook.result.current.selected?.title).toBe('Second');
  });

  it('ignores a blank title', async () => {
    const hook = await renderTodos();

    await expect(act(() => hook.result.current.add('   '))).resolves.toBe(false);
    expect(hook.result.current.list).toEqual([]);
  });
});
