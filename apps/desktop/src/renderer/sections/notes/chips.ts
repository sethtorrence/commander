import type { BlockLinkTarget } from '@commander/domain';
import { accentColour, accentTextColour } from '@commander/ui';
import type { LabelChip } from '../../links/block-text';

/*
  Chips in a Block's editable text. A Block's text keeps its `[[` tokens as they are stored, so the
  editor's text (textContent), caret offsets and copy and paste all stay in stored characters, as
  with Markdown's marks (markdown.ts). Each token is drawn as a chip: a non-editable span holding the
  token itself, hidden, with its label shown by CSS (links.css). The caret goes beside a chip, never
  inside it (caret.ts, block-editor.ts), and Backspace or Delete next to one removes it whole (the
  Notebook's `unlink`).
*/

export type { LabelChip };

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/** The markup for one chip: its token, hidden, and its label (data-label) drawn by CSS. */
export function chipHtml(token: string, target: BlockLinkTarget, label: LabelChip): string {
  const shown = label(target);
  const attributes: [string, string][] = [
    ['class', 'n-chip'],
    ['contenteditable', 'false'],
    ['role', 'link'],
    ['data-chip', target.type],
    ['data-token', token],
    ['data-label', shown.text],
    ['aria-label', shown.text],
    ['title', shown.title],
  ];
  if (shown.project) {
    attributes.push(['data-code', shown.project.code]);
    const ink = accentTextColour(shown.project.accent);
    const style = `--accent: ${accentColour(shown.project.accent)};${ink ? ` --on-chip: ${ink};` : ''}`;
    attributes.push(['style', style]);
  }
  const html = attributes.map(([name, value]) => `${name}="${escapeHtml(value)}"`).join(' ');
  return `<span ${html}><span class="n-chip-raw">${escapeHtml(token)}</span></span>`;
}

/** The chip an event happened on, if any. */
export function chipAt(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>('.n-chip') : null;
}

/**
 * Where a text position lands when it falls in a chip: before it at its start, after it anywhere
 * else. Null when the node isn't in a chip within `element`.
 */
export function besideChip(element: HTMLElement, node: Node, offset: number): [Node, number] | null {
  const chip = node.parentElement?.closest('[contenteditable="false"]');
  if (!chip || chip === element || !element.contains(chip) || !chip.parentNode) return null;
  const index = [...chip.parentNode.childNodes].indexOf(chip as ChildNode);
  return [chip.parentNode, offset <= 0 ? index : index + 1];
}
