import { type BlockStyle, meetingChipEventId } from '@commander/domain';
import type { Block, Outline } from './outline';

/*
  Line styles (#239): a Daily Note writes like Markdown. Each Block's line has a style: a plain line
  (the default, with no bullet), a heading, a bullet, a numbered item, a checkbox Todo or a quote. The
  style is how the line looks, not what it is: a Block's text, Links, Project and Todo don't depend
  on it, and its text never holds the style's mark.

  - Typing a shorthand at the start of a plain line gives it a style, and the mark goes: `- ` or `* `
    a bullet, `# ` to `### ` a heading, `1. ` a numbered item (`[ ] ` and `- [ ] ` make a checkbox
    Todo, block-todos.ts). Backspace at the start of a styled line makes it plain again.
  - Only list items (bullets and numbered items) nest as the User writes: Tab puts one under the list
    item above, Shift+Tab takes it back out (outline.ts).
  - A meeting chip and the lines under it are the meeting's quote: its notes are quote lines, so a
    plain line there is a quote line, and the meeting's Project is theirs.
*/

/** A Block's style; a Block written without one is a plain line. */
export const styleOf = (block: Block): BlockStyle => block.style ?? 'plain';

/** Bullets and numbered items: the lines that continue on Enter and nest with Tab. */
export const isListItem = (block: Block | undefined): boolean =>
  block?.style === 'bullet' || block?.style === 'numbered';

/** A heading's level, 1 to 3, or 0 for any other style. */
export function headingOf(style: BlockStyle | undefined): 0 | 1 | 2 | 3 {
  return style === 'heading-1' ? 1 : style === 'heading-2' ? 2 : style === 'heading-3' ? 3 : 0;
}

/** Whether a Block is a meeting chip: it starts with a calendar event's link. */
export const isMeetingChip = (block: Block | undefined): boolean =>
  !!block && meetingChipEventId(block.text) !== null;

/** Whether a Block is a meeting chip or a line under one, at any depth: in that meeting's quote. */
export function inMeeting(outline: Outline, id: string | null): boolean {
  const seen = new Set<string>();
  for (let block = id === null ? undefined : outline.get(id); block && !seen.has(block.id); ) {
    if (isMeetingChip(block)) return true;
    seen.add(block.id);
    block = block.parentId === null ? undefined : outline.get(block.parentId);
  }
  return false;
}

/** The style of a plain line under `parentId`: a quote line inside a meeting, a plain line elsewhere. */
export const plainStyleUnder = (outline: Outline, parentId: string | null): BlockStyle =>
  inMeeting(outline, parentId) ? 'quote' : 'plain';

/** The parent a Block is shown under, as the outline places it. */
const shownParent = (outline: Outline, block: Block) =>
  block.parentId !== null && outline.has(block.parentId) ? block.parentId : null;

/**
 * Whether Backspace at the Block's start has a style to take off: anything but a plain line (a quote
 * line in a meeting). A meeting chip stays its meeting's quote.
 */
export const hasLineStyle = (outline: Outline, block: Block): boolean =>
  !isMeetingChip(block) && styleOf(block) !== plainStyleUnder(outline, shownParent(outline, block));

// The shorthands, as typed at the start of a line, longest first.
const SHORTHANDS: [RegExp, BlockStyle][] = [
  [/^### /, 'heading-3'],
  [/^## /, 'heading-2'],
  [/^# /, 'heading-1'],
  [/^[-*] /, 'bullet'],
  [/^\d{1,9}\. /, 'numbered'],
];

/** The shorthand a line's text starts with, if any: its style and the length of its mark. */
export function shorthandIn(text: string): { style: BlockStyle; length: number } | null {
  for (const [mark, style] of SHORTHANDS) {
    const found = mark.exec(text);
    if (found) return { style, length: found[0].length };
  }
  return null;
}

/**
 * Each numbered item's number: they count up from 1 along a run of numbered siblings, and anything
 * else between them starts the count again, so the numbers follow every edit.
 */
export function listNumbers(tree: ReadonlyMap<string | null, readonly Block[]>): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const siblings of tree.values()) {
    let count = 0;
    for (const block of siblings) {
      count = styleOf(block) === 'numbered' ? count + 1 : 0;
      if (count) numbers.set(block.id, count);
    }
  }
  return numbers;
}
