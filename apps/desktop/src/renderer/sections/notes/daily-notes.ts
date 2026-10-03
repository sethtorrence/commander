import type { DailyNotePage, DailyNoteQuery, Item, ItemAction } from '@commander/domain';
import type { ItemStoreClient } from '../../item-store/client';
import { sameSavedBlock, todoActionsFor } from './block-todos';
import type { Block, BlockChange, Outline } from './outline';

/*
  The Notes Section's view of the Item store: everything it reads or changes goes through here. A
  Daily Note is an Item for one day, and each Block an Item whose detail holds its Daily Note, parent,
  position and text (ADR 0002). Reached only through the window's bridge, so every change is the User's.
*/

export interface DailyNotes {
  /**
   * The id of the Daily Note for a day (YYYY-MM-DD), made if there isn't one yet. With `fromTemplate`
   * (the day is being made as today), a new one starts with a copy of the daily template.
   */
  ensure(day: string, options?: { fromTemplate?: boolean }): Promise<string>;
  /** Daily Notes, newest first. */
  list(query: DailyNoteQuery): Promise<DailyNotePage>;
  /** The Blocks of these Daily Notes, by Daily Note id, each with its Todo if it is one. */
  blocks(dailyNoteIds: string[]): Promise<Map<string, Block[]>>;
  /**
   * Saves Block changes to a Daily Note as one, and returns their activity entries' ids, in order.
   * Given the Blocks as saved before (`before`), their Todos change with them (block-todos.ts), and a
   * Block whose saved part didn't change (only its Todo was ticked) isn't recorded itself.
   */
  save(dailyNoteId: string, changes: BlockChange[], why: string, before?: Outline): Promise<number[]>;
  /** The day (YYYY-MM-DD) of the Daily Note a Block is in, or null if there is no such Block. */
  dayOfBlock(blockId: string): Promise<string | null>;
  /** False where Blocks can't become Todos (the daily template); they can otherwise. */
  readonly todos?: boolean;
  /**
   * Undoes activity entries (given in the order they were made) last first, as one. Returns the undo
   * entries' ids in the order they were made, so passing them back here redoes the change.
   */
  undo(entryIds: number[]): Promise<number[]>;
}

export function blockOf(item: Item): Block | null {
  if (item.detail?.kind !== 'block') return null;
  const { parentId, position, text, folded } = item.detail;
  return { id: item.id, parentId, position, text, folded };
}

function actionFor(dailyNoteId: string, change: BlockChange): ItemAction {
  if (change.type === 'delete') return { type: 'delete', itemId: change.id };
  const { id, parentId, position, text, folded } = change.block;
  const detail = { kind: 'block' as const, dailyNoteId, parentId, position, text, folded };
  return change.type === 'create'
    ? { type: 'create', item: { id, kind: 'block', title: text, detail } }
    : { type: 'update', itemId: id, changes: { detail } };
}

export function dailyNotesIn(itemStore: ItemStoreClient): DailyNotes {
  return {
    async ensure(day, options) {
      return (await itemStore({ op: 'daily-note', day, ...options })).id;
    },

    list(query) {
      return itemStore({ op: 'daily-notes', query });
    },

    async blocks(dailyNoteIds) {
      const byNote = new Map<string, Block[]>(dailyNoteIds.map((id) => [id, []]));
      if (!dailyNoteIds.length) return byNote;
      const [items, made] = await Promise.all([
        itemStore({ op: 'blocks', dailyNoteIds }),
        itemStore({ op: 'block-todos', query: { dailyNoteIds } }),
      ]);
      // Should a Block have more than one live Todo, the latest made wins.
      const todos = new Map(made.map(({ todo, block }) => [block.id, todo]));
      for (const item of items) {
        const block = blockOf(item);
        const todo = todos.get(item.id);
        if (todo && block) block.todo = { id: todo.id, done: todo.status === 'done' };
        if (block && item.detail?.kind === 'block') byNote.get(item.detail.dailyNoteId)?.push(block);
      }
      return byNote;
    },

    async save(dailyNoteId, changes, why, before) {
      // Ticking a Todo Block changes only its Todo: the Block itself has nothing new to record.
      const onlyTodo = (change: BlockChange) => {
        const was = change.type === 'update' && before?.get(change.block.id);
        return !!was && change.type === 'update' && sameSavedBlock(was, change.block);
      };
      const actions = [
        ...changes.filter((change) => !onlyTodo(change)).map((change) => actionFor(dailyNoteId, change)),
        ...(before ? todoActionsFor(before, changes) : []),
      ];
      if (!actions.length) return [];
      return (await itemStore({ op: 'record-all', actions, why })).map((entry) => entry.id);
    },

    async dayOfBlock(blockId) {
      const block = await itemStore({ op: 'get', itemId: blockId });
      if (block?.item.detail?.kind !== 'block') return null;
      const note = await itemStore({ op: 'get', itemId: block.item.detail.dailyNoteId });
      return note?.item.detail?.kind === 'daily-note' ? note.item.detail.day : null;
    },

    async undo(entryIds) {
      if (!entryIds.length) return [];
      const actions = [...entryIds].reverse().map((entryId): ItemAction => ({ type: 'undo', entryId }));
      return (await itemStore({ op: 'record-all', actions })).map((entry) => entry.id);
    },
  };
}
