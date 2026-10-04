// Ares's first job, "Suggest Todos": the User writes "need to send Dana the Q3 numbers" in a Daily
// Note, pauses, and Ares offers a Todo for it. A Quick job at low thinking: one call, no tools, and a
// reply that must fit OUTPUT exactly.
//
// - Runs about 20 seconds after the User stops typing, on the Blocks they changed since its last run,
//   and on the idle catch-up (or a request) over today's note as well.
// - Sends each Block that might hold something to do (written, not an image, not a Todo already, no
//   suggestion of Ares's waiting on it, and not looked at before with the same text), with the
//   Blocks above it as context. Blocks are the User's own words, so it reads no outside content
//   (the prompt builder marks them trusted by where they came from).
// - Each reply entry becomes a proposal on its Block, Organise / "Suggest Todos": create a Todo
//   (origin Ares, the Block's Project as inherited) with a made-from Link to the Block. The gate adds
//   it or keeps it as a suggestion for the margin of the Daily Note.
// - The runner remembers every Block it sent, with its text, so a dismissed suggestion (or an Ares
//   Todo undone) is never offered again for the same text.
import { type Item, imageAttachmentOf, inheritedFiling } from '@commander/domain';
import { z } from 'zod';
import type { ItemStore } from '../item-store';
import type { AgentJob, JobInput } from './runner';

export const SUGGEST_TODOS = 'suggest-todos';

// About this long after the User stops typing.
export const TYPING_PAUSE_MS = 20_000;
// At most this many Blocks per call; the rest wait for the next run.
const MAX_BLOCKS = 40;
const MAX_TITLE = 120;

export const OUTPUT = z.object({
  todos: z
    .array(
      z.object({
        // The reference the prompt gave the Block (B1, B2…), never its id.
        blockId: z.string().min(1).max(20),
        title: z.string().trim().min(1).max(300),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(100),
});
type Output = z.infer<typeof OUTPUT>;

type Offered = { ref: string; item: Item; text: string };
// Each Daily Note as the prompt shows it: its outline lines, and the Blocks they are (the User's own
// words, so the prompt builder marks them trusted).
type Input = JobInput & { offered: Offered[]; notes: { title: string; lines: string[]; blocks: Item[] }[] };

const INSTRUCTIONS = `You are Ares. You find the things the User needs to do in their own Daily Note.

Each line in the data is a Block the User wrote; Blocks sit under the Blocks above them. Only the Blocks marked with a reference ([B1], [B2]…) are for you to judge; the others are there as context. For each marked Block, decide whether it holds something the User needs to do: a task, errand, follow-up or commitment ("need to send Dana the Q3 numbers", "call the bank about the card", "remember to book flights").

These are not things to do: headings and section names ("Morning", "Meetings"), notes and facts ("Priya leads the reliability push"), ideas with no commitment, questions, things already done ("sent the deck"), and things someone else will do.

Reply with only this JSON object: {"todos":[{"blockId":"B1","title":"…","confidence":0.9}]}
- One entry per marked Block that holds something to do. Leave the others out; an empty list is fine.
- blockId: the Block's reference, exactly as marked.
- title: the thing to do as a short instruction starting with a verb, in the User's words: "Send Dana the Q3 numbers". Drop "need to", "remember to", "todo:" and the like. Keep names, dates and numbers. No full stop.
- confidence: how sure you are that the User needs to do it, from 0 to 1. 0.9 or more when they plainly said so ("need to", "must", "have to", a clear instruction to themselves); 0.5 to 0.8 when it is likely but tentative ("maybe", "should probably"); leave out anything below 0.3.`;

// What the job remembers a Block by: its text, give or take spacing and case.
export const fingerprintOf = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (at: number) => {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const textOf = (item: Item) => (item.detail?.kind === 'block' ? item.detail.text : '');
const parentOf = (item: Item) => (item.detail?.kind === 'block' ? item.detail.parentId : null);

function cleanTitle(title: string): string {
  const one = title
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。]+$/, '');
  return one.length > MAX_TITLE ? `${one.slice(0, MAX_TITLE - 1).trimEnd()}…` : one;
}

export function suggestTodosJob(
  itemStore: ItemStore,
  { now = Date.now }: { now?: () => number } = {},
): AgentJob<Input, Output> {
  // Whether a Block is a Todo already: a live Todo made from it.
  const isTodo = (blockId: string) =>
    !!itemStore
      .get(blockId)
      ?.backlinks.some(
        (link) => link.type === 'made-from' && link.from.kind === 'todo' && link.from.deletedAt === null,
      );

  const hasSuggestion = (blockId: string) =>
    itemStore.autonomy
      .proposals({ itemId: blockId, statuses: ['pending'] })
      .some((proposal) => proposal.action === SUGGEST_TODOS);

  // A live, written Block that isn't a Todo yet: one the job could suggest a Todo for.
  function candidate(itemId: string): Item | null {
    const item = itemStore.get(itemId)?.item;
    if (item?.kind !== 'block' || item.deletedAt !== null) return null;
    const text = textOf(item).trim();
    if (!text || imageAttachmentOf(text)) return null;
    if (isTodo(itemId) || hasSuggestion(itemId)) return null;
    return item;
  }

  // Each Daily Note's offered Blocks as an outline, with the Blocks above them as context lines.
  function outlines(blocks: Item[]): { offered: Offered[]; notes: Input['notes'] } {
    const byNote = new Map<string, Set<string>>();
    for (const block of blocks) {
      if (block.detail?.kind !== 'block') continue;
      const ids = byNote.get(block.detail.dailyNoteId) ?? new Set<string>();
      byNote.set(block.detail.dailyNoteId, ids.add(block.id));
    }
    const notes = [...byNote.keys()]
      .map((id) => itemStore.get(id)?.item)
      .filter((note): note is Item => note?.detail?.kind === 'daily-note')
      .sort((a, b) =>
        a.detail?.kind === 'daily-note' && b.detail?.kind === 'daily-note' && a.detail.day < b.detail.day
          ? -1
          : 1,
      );
    const offered: Offered[] = [];
    const rendered: Input['notes'] = [];
    for (const note of notes) {
      const wanted = byNote.get(note.id) ?? new Set();
      const all = itemStore.blocks([note.id]);
      const byId = new Map(all.map((block) => [block.id, block]));
      const shown = new Set<string>();
      for (const id of wanted) {
        for (let at: string | null = id; at && !shown.has(at); at = parentOf(byId.get(at) as Item)) {
          if (!byId.has(at)) break;
          shown.add(at);
        }
      }
      const children = new Map<string | null, Item[]>();
      for (const block of all) {
        if (!shown.has(block.id)) continue;
        const siblings = children.get(parentOf(block)) ?? [];
        children.set(parentOf(block), [...siblings, block]);
      }
      const lines: string[] = [];
      const blocks: Item[] = [];
      const walk = (parent: string | null, depth: number) => {
        const position = (block: Item) => (block.detail?.kind === 'block' ? block.detail.position : '');
        const kids = [...(children.get(parent) ?? [])].sort((a, b) => (position(a) < position(b) ? -1 : 1));
        for (const block of kids) {
          let mark = '';
          if (wanted.has(block.id)) {
            const ref = `B${offered.length + 1}`;
            offered.push({ ref, item: block, text: textOf(block).trim() });
            mark = `[${ref}] `;
          }
          blocks.push(block);
          lines.push(
            `${'  '.repeat(depth)}- ${mark}${textOf(block)
              .replace(/\s*\n\s*/g, ' ')
              .trim()}`,
          );
          walk(block.id, depth + 1);
        }
      };
      walk(null, 0);
      rendered.push({ title: note.title, lines, blocks });
    }
    return { offered, notes: rendered };
  }

  return {
    job: SUGGEST_TODOS,
    name: 'Suggest Todos',
    tier: 'quick',
    reasoningEffort: 'low',
    action: {
      action: SUGGEST_TODOS,
      actionKind: 'organise',
      section: 'notes',
      hint: 'Todos from what you write in your Daily Notes',
    },
    triggers: { typing: { pauseMs: TYPING_PAUSE_MS }, idle: true },

    gather({ triggers, cursor, seen }) {
      const changes = itemStore.agent.userChangesSince(cursor, ['block']);
      // Before its first run it starts from today's note rather than every Block ever written.
      const ids = new Set(cursor === null ? [] : changes.itemIds);
      for (const trigger of triggers)
        if ('itemIds' in trigger) for (const id of trigger.itemIds ?? []) ids.add(id);
      const catchUp =
        cursor === null || triggers.some((trigger) => trigger.kind === 'idle' || trigger.kind === 'request');
      if (catchUp) {
        const day = localDay(now());
        const today = itemStore.dailyNotes({ from: day, to: day, limit: 1 }).notes[0];
        if (today) for (const block of itemStore.blocks([today.item.id])) ids.add(block.id);
      }
      const blocks = [...ids]
        .map(candidate)
        .filter((item): item is Item => item !== null && !seen(item.id, fingerprintOf(textOf(item))));
      const taken = blocks.slice(0, MAX_BLOCKS);
      // With Blocks left over, the cursor stays put so the next run gets to them.
      const next = blocks.length > MAX_BLOCKS ? (cursor ?? undefined) : changes.lastEntryId;
      const { offered, notes } = outlines(taken);
      return {
        items: offered.map(({ item, text }) => ({ itemId: item.id, fingerprint: fingerprintOf(text) })),
        ...(next !== undefined && { cursor: next }),
        offered,
        notes,
      };
    },

    prompt: (input) => ({
      instructions: INSTRUCTIONS,
      data: input.notes.map((note) => ({
        label: `Daily Note · ${note.title}`,
        from: note.blocks,
        text: note.lines.join('\n'),
      })),
    }),

    output: OUTPUT,

    proposals(output, input) {
      const byRef = new Map(input.offered.map((offered) => [offered.ref, offered]));
      const used = new Set<string>();
      const dropped: string[] = [];
      const proposals = output.todos.flatMap((todo) => {
        const offered = byRef.get(todo.blockId);
        if (!offered) {
          dropped.push(`it named ${todo.blockId}, which it wasn’t given`);
          return [];
        }
        if (used.has(todo.blockId)) {
          dropped.push(`it named ${todo.blockId} twice`);
          return [];
        }
        used.add(todo.blockId);
        // The User may have changed it while Ares was thinking.
        const block = candidate(offered.item.id);
        if (!block || fingerprintOf(textOf(block)) !== fingerprintOf(offered.text)) {
          dropped.push(`${todo.blockId} changed while Ares was looking at it`);
          return [];
        }
        const title = cleanTitle(todo.title);
        return [
          {
            itemId: block.id,
            itemActions: [
              {
                type: 'create' as const,
                item: {
                  kind: 'todo' as const,
                  title,
                  filing: inheritedFiling(block.filing),
                  detail: { kind: 'todo' as const, origin: 'ares' as const, dueOn: null, backedBy: null },
                },
              },
              { type: 'link' as const, from: { step: 0 }, linkType: 'made-from' as const, to: block.id },
            ],
            confidence: todo.confidence,
            reason: `You wrote “${offered.text}” in your Daily Note.`,
          },
        ];
      });
      return { proposals, dropped };
    },
  };
}
