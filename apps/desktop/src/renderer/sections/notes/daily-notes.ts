import type { DailyNotePage, DailyNoteQuery, Item, ItemAction } from '@commander/domain';
import type { ItemStoreClient } from '../../item-store/client';
import type { Block, BlockChange } from './outline';

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
  /** The Blocks of these Daily Notes, by Daily Note id. */
  blocks(dailyNoteIds: string[]): Promise<Map<string, Block[]>>;
  /** Saves Block changes to a Daily Note as one, and returns their activity entries' ids, in order. */
  save(dailyNoteId: string, changes: BlockChange[], why: string): Promise<number[]>;
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
      for (const item of await itemStore({ op: 'blocks', dailyNoteIds })) {
        const block = blockOf(item);
        if (block && item.detail?.kind === 'block') byNote.get(item.detail.dailyNoteId)?.push(block);
      }
      return byNote;
    },

    async save(dailyNoteId, changes, why) {
      if (!changes.length) return [];
      const actions = changes.map((change) => actionFor(dailyNoteId, change));
      return (await itemStore({ op: 'record-all', actions, why })).map((entry) => entry.id);
    },

    async undo(entryIds) {
      if (!entryIds.length) return [];
      const actions = [...entryIds].reverse().map((entryId): ItemAction => ({ type: 'undo', entryId }));
      return (await itemStore({ op: 'record-all', actions })).map((entry) => entry.id);
    },
  };
}
