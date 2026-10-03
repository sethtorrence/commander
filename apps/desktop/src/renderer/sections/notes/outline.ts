import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

/*
  The outliner model for one Daily Note: its Blocks as a tree, and the edits the outliner keys make
  to it. Everything here is pure. Each edit returns the new outline, the Block changes to save (one
  per Block touched, so a move or indent is a single change), and where the caret goes next.

  Siblings sort by `position`, a fractional index: a Block can go between two others by changing only
  its own position, never renumbering its neighbours.
*/

export interface Block {
  id: string;
  /** The Block it nests under, or null at the top of the Daily Note. */
  parentId: string | null;
  position: string;
  text: string;
  folded: boolean;
}

export type Outline = ReadonlyMap<string, Block>;

export type BlockChange =
  | { type: 'create'; block: Block }
  | { type: 'update'; block: Block }
  | { type: 'delete'; id: string };

/** Where the caret goes after an edit: a Block, and a character offset in its text. */
export interface Caret {
  id: string;
  offset: number;
}

export interface Edit {
  outline: Outline;
  changes: BlockChange[];
  focus?: Caret;
}

export function outlineOf(blocks: Iterable<Block>): Outline {
  return new Map([...blocks].map((block) => [block.id, block]));
}

const byPosition = (a: Block, b: Block) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** The parent a Block is shown under: a Block whose parent is missing shows at the top. */
const parentIn = (outline: Outline, block: Block) =>
  block.parentId !== null && outline.has(block.parentId) ? block.parentId : null;

export function childrenOf(outline: Outline, parentId: string | null): Block[] {
  return [...outline.values()].filter((block) => parentIn(outline, block) === parentId).sort(byPosition);
}

/** Every Block's children in order, by parent id (null for the top level). */
export function treeOf(outline: Outline): Map<string | null, Block[]> {
  const tree = new Map<string | null, Block[]>();
  for (const block of outline.values()) {
    const parent = parentIn(outline, block);
    const siblings = tree.get(parent);
    if (siblings) siblings.push(block);
    else tree.set(parent, [block]);
  }
  for (const siblings of tree.values()) siblings.sort(byPosition);
  return tree;
}

export const hasChildren = (outline: Outline, id: string) =>
  [...outline.values()].some((block) => parentIn(outline, block) === id);

export interface PlacedBlock {
  block: Block;
  depth: number;
}

/**
 * The Blocks in outline order (depth first), with their depth. The children of folded Blocks are left
 * out unless `includeFolded`.
 */
export function visibleBlocks(outline: Outline, { includeFolded = false } = {}): PlacedBlock[] {
  const children = treeOf(outline);
  const placed: PlacedBlock[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const block of children.get(parentId) ?? []) {
      placed.push({ block, depth });
      if (includeFolded || !block.folded) walk(block.id, depth + 1);
    }
  };
  walk(null, 0);
  return placed;
}

/** Each Block's number on the sheet ("001"), counting every Block in outline order, folded ones included. */
export function blockNumbers(outline: Outline): Map<string, string> {
  return new Map(
    visibleBlocks(outline, { includeFolded: true }).map(({ block }, i) => [
      block.id,
      String(i + 1).padStart(3, '0'),
    ]),
  );
}

/** How many Blocks sit under this one, at any depth. */
export function descendantCount(outline: Outline, id: string): number {
  return childrenOf(outline, id).reduce((sum, child) => sum + 1 + descendantCount(outline, child.id), 0);
}

// A position between two siblings' positions (null for either end).
function between(before: string | null, after: string | null): string {
  // Two siblings with the same position (never made here) would leave no room: go after the first.
  if (before !== null && after !== null && before >= after) return generateKeyBetween(before, null);
  return generateKeyBetween(before, after);
}

// The edit of applying these changes to the outline.
function change(outline: Outline, changes: BlockChange[], focus?: Caret): Edit {
  const next = new Map(outline);
  for (const c of changes) {
    if (c.type === 'delete') next.delete(c.id);
    else next.set(c.block.id, c.block);
  }
  return { outline: next, changes, focus };
}

function siblingsAround(outline: Outline, block: Block) {
  const siblings = childrenOf(outline, parentIn(outline, block));
  const index = siblings.findIndex((s) => s.id === block.id);
  return { siblings, index, previous: siblings[index - 1], next: siblings[index + 1] };
}

/** An empty Daily Note's first Block. */
export function startOutline(id: string, outline: Outline = new Map()): Edit {
  const first = childrenOf(outline, null)[0];
  const block: Block = {
    id,
    parentId: null,
    position: between(null, first?.position ?? null),
    text: '',
    folded: false,
  };
  return change(outline, [{ type: 'create', block }], { id, offset: 0 });
}

/** Enter, with the selection from `start` to `end` in the Block's text. `newId` is the id for a new Block. */
export function enter(outline: Outline, id: string, start: number, end: number, newId: string): Edit | null {
  const block = outline.get(id);
  if (!block) return null;
  const { next, previous } = siblingsAround(outline, block);
  const parentId = parentIn(outline, block);

  // An empty last child steps out a level, as the next line of its parent's list.
  if (block.text === '' && parentId !== null && !next) return outdent(outline, id);

  // At the very start of a Block with text: a new empty Block goes above, and the caret stays.
  if (start === 0 && end === 0 && block.text !== '') {
    const above: Block = {
      id: newId,
      parentId,
      position: between(previous?.position ?? null, block.position),
      text: '',
      folded: false,
    };
    return change(outline, [{ type: 'create', block: above }], { id, offset: 0 });
  }

  const kept = block.text.slice(0, start);
  const carried = block.text.slice(end);
  const changes: BlockChange[] = [];
  if (kept !== block.text) changes.push({ type: 'update', block: { ...block, text: kept } });

  // Under an open parent the new Block becomes its first child; otherwise it follows as a sibling.
  const children = childrenOf(outline, id);
  const intoChildren = children.length > 0 && !block.folded;
  const fresh: Block = intoChildren
    ? {
        id: newId,
        parentId: id,
        position: between(null, children[0]?.position ?? null),
        text: carried,
        folded: false,
      }
    : {
        id: newId,
        parentId,
        position: between(block.position, next?.position ?? null),
        text: carried,
        folded: false,
      };
  changes.push({ type: 'create', block: fresh });
  return change(outline, changes, { id: newId, offset: 0 });
}

/** Tab: the Block becomes the last child of the sibling above it, bringing its children. */
export function indent(outline: Outline, id: string): Edit | null {
  const block = outline.get(id);
  if (!block) return null;
  const { previous } = siblingsAround(outline, block);
  if (!previous) return null;
  const last = childrenOf(outline, previous.id).at(-1);
  const changes: BlockChange[] = [];
  if (previous.folded) changes.push({ type: 'update', block: { ...previous, folded: false } });
  changes.push({
    type: 'update',
    block: { ...block, parentId: previous.id, position: between(last?.position ?? null, null) },
  });
  return change(outline, changes);
}

/** Shift+Tab: the Block moves out to just after its parent. Its later siblings stay where they are. */
export function outdent(outline: Outline, id: string): Edit | null {
  const block = outline.get(id);
  const parentId = block && parentIn(outline, block);
  const parent = parentId ? outline.get(parentId) : undefined;
  if (!block || !parent) return null;
  const { next } = siblingsAround(outline, parent);
  const moved: Block = {
    ...block,
    parentId: parentIn(outline, parent),
    position: between(parent.position, next?.position ?? null),
  };
  return change(outline, [{ type: 'update', block: moved }]);
}

/** Alt+Shift+Up or Down: the Block, with its children, swaps places with the sibling above or below. */
export function move(outline: Outline, id: string, direction: 'up' | 'down'): Edit | null {
  const block = outline.get(id);
  if (!block) return null;
  const { siblings, index } = siblingsAround(outline, block);
  const position =
    direction === 'up'
      ? index > 0 && between(siblings[index - 2]?.position ?? null, siblings[index - 1]?.position ?? null)
      : index < siblings.length - 1 &&
        between(siblings[index + 1]?.position ?? null, siblings[index + 2]?.position ?? null);
  if (!position) return null;
  return change(outline, [{ type: 'update', block: { ...block, position } }]);
}

// The Block shown just above this one in the same Daily Note.
function shownAbove(outline: Outline, id: string): Block | undefined {
  const shown = visibleBlocks(outline);
  const index = shown.findIndex(({ block }) => block.id === id);
  return index > 0 ? shown[index - 1]?.block : undefined;
}

function shownBelow(outline: Outline, id: string): Block | undefined {
  const shown = visibleBlocks(outline);
  const index = shown.findIndex(({ block }) => block.id === id);
  return index >= 0 ? shown[index + 1]?.block : undefined;
}

/**
 * Backspace at the start of a Block: an empty Block goes, and a Block with text joins onto the one shown
 * above. Children of a removed Block take its place. Null on the first Block.
 */
export function removeBackward(outline: Outline, id: string): Edit | null {
  const block = outline.get(id);
  const above = block && shownAbove(outline, id);
  if (!block || !above) return null;
  const end = { id: above.id, offset: above.text.length };
  const children = childrenOf(outline, id);
  // Joining a Block that has children onto another would muddle the tree: just go up.
  if (block.text !== '' && children.length) return { outline, changes: [], focus: end };

  const changes: BlockChange[] = [];
  if (children.length) {
    const { next } = siblingsAround(outline, block);
    const positions = generateNKeysBetween(block.position, next?.position ?? null, children.length);
    children.forEach((child, i) => {
      changes.push({
        type: 'update',
        block: { ...child, parentId: parentIn(outline, block), position: positions[i] ?? child.position },
      });
    });
  }
  if (block.text !== '') changes.push({ type: 'update', block: { ...above, text: above.text + block.text } });
  changes.push({ type: 'delete', id });
  return change(outline, changes, end);
}

/** Delete at the end of a Block: the Block shown below joins onto it, unless that one has children. */
export function joinNext(outline: Outline, id: string): Edit | null {
  const block = outline.get(id);
  const below = block && shownBelow(outline, id);
  if (!block || !below || hasChildren(outline, below.id)) return null;
  return change(
    outline,
    [
      { type: 'update', block: { ...block, text: block.text + below.text } },
      { type: 'delete', id: below.id },
    ],
    { id, offset: block.text.length },
  );
}

/** Clicking a bullet, or Ctrl+.: folds or unfolds a Block's children. */
export function toggleFold(outline: Outline, id: string, folded?: boolean): Edit | null {
  const block = outline.get(id);
  if (!block || !hasChildren(outline, id)) return null;
  const next = folded ?? !block.folded;
  if (next === block.folded) return null;
  return change(outline, [{ type: 'update', block: { ...block, folded: next } }]);
}

export function setText(outline: Outline, id: string, text: string): Edit | null {
  const block = outline.get(id);
  if (!block || block.text === text) return null;
  return change(outline, [{ type: 'update', block: { ...block, text } }]);
}
