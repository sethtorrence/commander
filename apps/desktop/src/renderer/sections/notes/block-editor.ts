import { attachmentMaxBytes, attachmentTypes, isOpenableLink } from '@commander/domain';
import { toast } from '@commander/ui';
import type { ClipboardEvent, KeyboardEvent, MouseEvent } from 'react';
import { selectionIn } from './caret';
import { besideChip, type LabelChip } from './chips';
import { blockHtml, linkSelection, type Mark, pastedUrl, type TextEdit } from './markdown';

/*
  What a Block's editable row does with Markdown (markdown.ts): showing its text rendered while the
  caret keeps its place, the formatting shortcuts, pasting a link onto selected text, opening links,
  and taking pasted or dropped images. The outliner keys stay in OutlineView.
*/

// The DOM position `offset` characters into an element's text.
function pointAt(element: HTMLElement, offset: number): [Node, number] {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.nodeValue?.length ?? 0;
    // A `[[` chip is one piece: a position in it goes before or after it.
    if (seen + length >= offset)
      return besideChip(element, node, offset - seen) ?? [node, Math.max(0, offset - seen)];
    seen += length;
  }
  return [element, element.childNodes.length];
}

/** Selects from `start` to `end` characters into an element's text. */
export function selectText(element: HTMLElement, start: number, end = start): void {
  const selection = getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStart(...pointAt(element, start));
  range.setEnd(...pointAt(element, end));
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Shows a Block's text rendered in its row (its chips labelled by `label`), keeping the selection
 * where it was in the text.
 */
export function renderBlockText(element: HTMLElement, text: string, label?: LabelChip): void {
  const editing = document.activeElement === element;
  const [start, end] = editing ? selectionIn(element) : [0, 0];
  element.innerHTML = blockHtml(text, label);
  if (editing) selectText(element, start, end);
}

/** Shows an edit made by a shortcut or a paste: the new text, with its selection. */
export function showEdit(element: HTMLElement, edit: TextEdit, label?: LabelChip): void {
  element.innerHTML = blockHtml(edit.text, label);
  selectText(element, edit.start, edit.end);
}

const SHORTCUT_MARKS: Record<string, Mark> = { b: '**', i: '*', e: '`' };

/** The mark a key press toggles: Ctrl+B bold, Ctrl+I italic, Ctrl+E inline code. */
export function formatShortcut(event: KeyboardEvent): Mark | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return null;
  return SHORTCUT_MARKS[event.key.toLowerCase()] ?? null;
}

/** Pasting text into a Block: a URL onto selected text makes a link; anything else goes in as one line. */
export function pasteText(event: ClipboardEvent<HTMLElement>, apply: (edit: TextEdit) => void): void {
  event.preventDefault();
  const element = event.currentTarget;
  const pasted = event.clipboardData.getData('text/plain');
  const url = pastedUrl(pasted);
  const [start, end] = selectionIn(element);
  const linked = url && linkSelection(element.textContent ?? '', start, end, url);
  if (linked) apply(linked);
  else document.execCommand('insertText', false, pasted.replace(/\r?\n+/g, ' '));
}

// ---- links ----

/**
 * The link a click opens: a click on a link while its Block isn't being edited, or Ctrl+click (Cmd on
 * a Mac) while it is. Null when the click is for placing the caret.
 */
export function linkClicked(event: MouseEvent<HTMLElement>): string | null {
  if (event.button !== 0 || !(event.target instanceof Element)) return null;
  const link = event.target.closest<HTMLElement>('[data-href]');
  if (!link || !event.currentTarget.contains(link)) return null;
  const editing = document.activeElement === event.currentTarget;
  if (editing && !(event.ctrlKey || event.metaKey)) return null;
  return link.dataset.href ?? null;
}

/**
 * Opens a link in the system browser. It asks for a new window, which the main process never makes:
 * it hands web and mail links to the system browser (external-links.ts) and drops anything else.
 */
export function openBlockLink(href: string): void {
  if (isOpenableLink(href)) window.open(href, '_blank', 'noopener');
  else toast('Only web and email links open from a Daily Note.');
}

// ---- images ----

const IMAGE_TYPES = new Set<string>(Object.values(attachmentTypes));

/** The images in a paste or drop. */
export function imageFiles(data: DataTransfer | null): File[] {
  return [...(data?.files ?? [])].filter((file) => IMAGE_TYPES.has(file.type));
}

/** Reads images for saving, leaving out (and saying so) any over the size limit. */
export async function readImages(files: File[]): Promise<Uint8Array[]> {
  const fitting = files.filter((file) => file.size <= attachmentMaxBytes);
  if (fitting.length < files.length) toast('Images can be up to 20 MB.');
  return Promise.all(fitting.map(async (file) => new Uint8Array(await file.arrayBuffer())));
}
