import { besideChip } from './chips';

// The caret inside a Block's editable text, as character offsets into its text.

/** The selection inside `element` as [start, end] offsets, or [0, 0] when it is elsewhere. */
export function selectionIn(element: HTMLElement): [number, number] {
  const selection = getSelection();
  if (!selection?.rangeCount) return [0, 0];
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return [0, 0];
  const upTo = document.createRange();
  upTo.selectNodeContents(element);
  upTo.setEnd(range.startContainer, range.startOffset);
  const start = upTo.toString().length;
  upTo.setEnd(range.endContainer, range.endOffset);
  return [start, upTo.toString().length];
}

/** Puts the caret at `offset` characters into `element`'s text (clamped to its end). */
export function placeCaret(element: HTMLElement, offset: number): void {
  const selection = getSelection();
  if (!selection) return;
  const range = document.createRange();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.nodeValue?.length ?? 0;
    if (seen + length >= offset) {
      // A chip (a non-editable `[[` link) is one piece: the caret goes before or after it.
      const beside = besideChip(element, node, offset - seen);
      if (beside) range.setStart(...beside);
      else range.setStart(node, Math.max(0, offset - seen));
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    seen += length;
  }
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function caretRect(): DOMRect | null {
  const selection = getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rects = range.getClientRects();
  return rects.length ? (rects[rects.length - 1] ?? null) : null;
}

/** Whether the caret is on the first visual line of `element` (so Up leaves the Block). */
export function onFirstLine(element: HTMLElement): boolean {
  const rect = caretRect();
  if (!rect?.height) return selectionIn(element)[0] === 0;
  return rect.top < element.getBoundingClientRect().top + 18;
}

/** Whether the caret is on the last visual line of `element` (so Down leaves the Block). */
export function onLastLine(element: HTMLElement): boolean {
  const rect = caretRect();
  if (!rect?.height) return selectionIn(element)[1] === (element.textContent ?? '').length;
  return rect.bottom > element.getBoundingClientRect().bottom - 18;
}

/** The caret's horizontal position, to keep the column when moving between Blocks. */
export const caretX = (element: HTMLElement) => caretRect()?.left ?? element.getBoundingClientRect().left;

/** Puts the caret in `element` on its top or bottom line, as near `x` as the text allows. */
export function placeCaretAtX(element: HTMLElement, x: number, edge: 'top' | 'bottom'): void {
  const box = element.getBoundingClientRect();
  const y = edge === 'bottom' ? box.bottom - 14 : box.top + 14;
  const clampedX = Math.min(Math.max(x, box.left + 1), box.right - 1);
  const position = y > 0 && y < innerHeight ? document.caretPositionFromPoint?.(clampedX, y) : null;
  const selection = getSelection();
  if (position && selection && element.contains(position.offsetNode)) {
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  placeCaret(element, edge === 'bottom' ? (element.textContent ?? '').length : 0);
}
