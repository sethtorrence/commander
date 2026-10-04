import { type ItemAction, isOwnFiling } from '@commander/domain';
import { type Block, type BlockChange, type Caret, type Edit, enter, type Outline } from './outline';

/*
  Blocks that are Todos (`[]` at the start of a Block). The Todo is its own Item, origin Daily Note,
  with a made-from Link to its Block; the Block shows a checkbox for it. In the outline a Block carries
  its Todo (`block.todo`) as the Notes Section wants it to be, and this module turns each saved change
  into the Todo's side of it, so the Block and its Todo are saved together as one change:

  - a Block that gains a Todo makes it, titled with the Block's text, and links it to the Block;
  - a Todo Block's text is its Todo's title, and ticking the checkbox ticks the Todo;
  - a Block that loses its Todo (the checkbox deleted), or is deleted, deletes its Todo.

  The Todos Section keeps the other direction: renaming such a Todo there changes its Block's text.
*/

/** `[]` or `[ ]` and a space at the very start of a Block's text: the Block becomes a Todo. */
export const TODO_MARK = /^\[ ?\] /;

// ---- edits: like the outline's own (outline.ts), each returns the new outline and the change ----

// An edit changing one Block.
function changeBlock(outline: Outline, block: Block, focus?: Caret): Edit {
  return { outline: new Map(outline).set(block.id, block), changes: [{ type: 'update', block }], focus };
}

const withoutTodo = ({ todo: _todo, ...block }: Block): Block => block;

/**
 * Text typed into a plain Block that starts with `[] `: the Block becomes a Todo (`todoId`), without
 * the mark. `caret` is where it was in the typed text. Null when there is no mark to act on.
 */
export function typeTodoMark(
  outline: Outline,
  id: string,
  text: string,
  caret: number | undefined,
  todoId: string,
): Edit | null {
  const block = outline.get(id);
  const mark = TODO_MARK.exec(text);
  if (!block || block.todo || !mark) return null;
  const rest = text.slice(mark[0].length);
  const offset = caret === undefined ? rest.length : Math.max(0, caret - mark[0].length);
  return changeBlock(outline, { ...block, text: rest, todo: { id: todoId, done: false } }, { id, offset });
}

/** Ctrl+Enter on a plain Block: it becomes a Todo (`todoId`). */
export function makeTodo(outline: Outline, id: string, todoId: string): Edit | null {
  const block = outline.get(id);
  if (!block || block.todo) return null;
  return changeBlock(outline, { ...block, todo: { id: todoId, done: false } });
}

/** The checkbox, or Ctrl+Enter on a Todo Block: ticks its Todo, or unticks it. */
export function tickTodo(outline: Outline, id: string): Edit | null {
  const block = outline.get(id);
  if (!block?.todo) return null;
  return changeBlock(outline, { ...block, todo: { ...block.todo, done: !block.todo.done } });
}

/** Backspace right after the checkbox: the Block becomes plain, and its Todo is to be deleted. */
export function removeTodo(outline: Outline, id: string): Edit | null {
  const block = outline.get(id);
  if (!block?.todo) return null;
  return changeBlock(outline, withoutTodo(block), { id, offset: 0 });
}

/**
 * Enter in a Todo Block: an empty one becomes a plain Block; otherwise Enter works as anywhere, and
 * the new Block is a Todo too. `newId` makes the ids for the new Block and its Todo.
 */
export function enterTodo(
  outline: Outline,
  id: string,
  start: number,
  end: number,
  newId: () => string,
): Edit | null {
  const block = outline.get(id);
  if (!block?.todo) return null;
  if (block.text === '') return removeTodo(outline, id);
  const edit = enter(outline, id, start, end, newId());
  if (!edit) return null;
  const next = new Map(edit.outline);
  const changes = edit.changes.map((change): BlockChange => {
    if (change.type !== 'create') return change;
    const fresh = { ...change.block, todo: { id: newId(), done: false } };
    next.set(fresh.id, fresh);
    return { type: 'create', block: fresh };
  });
  return { ...edit, outline: next, changes };
}

// ---- saving ----

// A Block's own Project, as saved: an inherited one is the Item store's to keep.
const ownProject = (block: Block) =>
  block.filing && isOwnFiling(block.filing) ? block.filing.projectId : null;

// What of a Block is saved on its Item: everything but its Todo, which is an Item of its own.
export const sameSavedBlock = (a: Block, b: Block) =>
  a.parentId === b.parentId &&
  a.position === b.position &&
  a.text === b.text &&
  a.folded === b.folded &&
  ownProject(a) === ownProject(b);

// The Todo's Item for a Block that became a Todo, and its made-from Link to the Block.
function todoActionsMaking(block: Block, todo: NonNullable<Block['todo']>): ItemAction[] {
  return [
    {
      type: 'create',
      item: {
        id: todo.id,
        kind: 'todo',
        title: block.text,
        status: todo.done ? 'done' : 'open',
        detail: { kind: 'todo', origin: 'daily-note', dueOn: null, backedBy: null },
      },
    },
    { type: 'link', from: todo.id, linkType: 'made-from', to: block.id },
  ];
}

/**
 * The Todo actions that go with these Block changes, given the Blocks as they were saved before them.
 * Recorded after the Blocks' own actions, in the same change.
 */
export function todoActionsFor(before: Outline, changes: readonly BlockChange[]): ItemAction[] {
  const actions: ItemAction[] = [];
  for (const change of changes) {
    if (change.type === 'delete') {
      const todo = before.get(change.id)?.todo;
      if (todo) actions.push({ type: 'delete', itemId: todo.id });
      continue;
    }
    const { block } = change;
    const was = before.get(block.id);
    const had = was?.todo;
    const has = block.todo;
    if (had && had.id !== has?.id) actions.push({ type: 'delete', itemId: had.id });
    if (!has) continue;
    if (!had || had.id !== has.id) {
      actions.push(...todoActionsMaking(block, has));
      continue;
    }
    const changed: { title?: string; status?: 'open' | 'done' } = {};
    if (was && was.text !== block.text) changed.title = block.text;
    if (had.done !== has.done) changed.status = has.done ? 'done' : 'open';
    if (Object.keys(changed).length) actions.push({ type: 'update', itemId: has.id, changes: changed });
  }
  return actions;
}
