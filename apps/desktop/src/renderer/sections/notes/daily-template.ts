import type { TemplateBlock } from '@commander/domain';
import type { ItemStoreClient } from '../../item-store/client';
import type { DailyNotes } from './daily-notes';
import type { Block, BlockChange } from './outline';

/*
  The daily template as the Notes outliner sees it, so Settings → Notes → Daily template edits it with
  the same Notebook and OutlineView as a Daily Note: the template stands in for one day (TEMPLATE_DAY).

  The template is a setting, not Items (its Blocks are copied into each new day with fresh ids), so it
  is saved whole after each change, and undo is kept here rather than in the activity log: each save
  is one entry, holding every Block it changed before and after, and undoing an entry is itself an
  entry, so undoing that redoes it.
*/

/** The editor's one "day". */
export const TEMPLATE_DAY = 'daily-template';
const TEMPLATE_NOTE = 'daily-template';

type Change = { id: string; before: Block | null; after: Block | null };

export function templateIn(itemStore: ItemStoreClient): DailyNotes {
  let blocks = new Map<string, Block>();
  const entries = new Map<number, Change[]>();
  let lastEntry = 0;

  const apply = (changes: Change[]) => {
    for (const { id, after } of changes) {
      if (after) blocks.set(id, after);
      else blocks.delete(id);
    }
  };
  const record = (changes: Change[]) => {
    entries.set(++lastEntry, changes);
    return lastEntry;
  };
  const persist = async () => {
    const saved: TemplateBlock[] = [...blocks.values()].map(({ id, parentId, position, text, folded }) => ({
      id,
      parentId,
      position,
      text,
      folded,
    }));
    await itemStore({ op: 'save-daily-template', template: { blocks: saved } });
  };

  return {
    async ensure() {
      return TEMPLATE_NOTE;
    },

    async list() {
      return { notes: [], total: 0 };
    },

    async blocks(ids) {
      const template = await itemStore({ op: 'daily-template' });
      blocks = new Map(template.blocks.map((block) => [block.id, block]));
      return new Map(ids.map((id) => [id, id === TEMPLATE_NOTE ? [...blocks.values()] : []]));
    },

    async save(_noteId, changes: BlockChange[]) {
      if (!changes.length) return [];
      const made = changes.map((change): Change => {
        const id = change.type === 'delete' ? change.id : change.block.id;
        const after = change.type === 'delete' ? null : change.block;
        return { id, before: blocks.get(id) ?? null, after };
      });
      apply(made);
      await persist();
      return [record(made)];
    },

    async undo(entryIds) {
      if (!entryIds.length) return [];
      const undone: number[] = [];
      for (const entryId of [...entryIds].reverse()) {
        const inverse = [...(entries.get(entryId) ?? [])]
          .reverse()
          .map(({ id, before, after }) => ({ id, before: after, after: before }));
        apply(inverse);
        undone.push(record(inverse));
      }
      await persist();
      return undone;
    },
  };
}
