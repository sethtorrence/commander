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

const attributesHtml = (attributes: [string, string][]) =>
  attributes.map(([name, value]) => `${name}="${escapeHtml(value)}"`).join(' ');

/**
 * A meeting chip (#128): the event's compact live card, drawn by CSS from empty parts (links.css), so
 * the chip's text is still only its token. The calendar colour, the Badge of the event's Project, the
 * times and title, Join (the online meeting's link, while the meeting is on) and what happened to it
 * (struck through when cancelled or declined, "Moved to Thu 10:00").
 */
function meetingHtml(token: string, shown: ReturnType<LabelChip>): string {
  const card = shown.meeting;
  let style = `--cal: ${card?.colour ?? 'transparent'};`;
  if (shown.project) {
    const ink = accentTextColour(shown.project.accent);
    style += ` --accent: ${accentColour(shown.project.accent)};${ink ? ` --on-chip: ${ink};` : ''}`;
  }
  const state = card?.struck ? 'struck' : card?.status ? 'moved' : 'on';
  const html = attributesHtml([
    ['class', 'n-chip n-meet'],
    ['contenteditable', 'false'],
    ['role', 'link'],
    ['data-chip', 'event'],
    ['data-token', token],
    ['data-label', shown.text],
    ['data-state', state],
    ['aria-label', card?.status ? `${shown.text} (${card.status})` : shown.text],
    ['title', shown.title],
    ['style', style],
  ]);
  const parts = [
    `<span class="n-chip-raw">${escapeHtml(token)}</span>`,
    '<span class="n-meet-cal"></span>',
    shown.project
      ? `<span class="n-meet-badge" ${attributesHtml([['data-code', shown.project.code]])}></span>`
      : '',
    `<span class="n-meet-label" ${attributesHtml([['data-label', shown.text]])}></span>`,
    card?.joinUrl
      ? `<span class="n-meet-join" ${attributesHtml([
          ['data-join', card.joinUrl],
          ['title', `Join the meeting: ${card.joinUrl}`],
        ])}></span>`
      : '',
    card?.status ? `<span class="n-meet-note" ${attributesHtml([['data-note', card.status]])}></span>` : '',
  ];
  return `<span ${html}>${parts.join('')}</span>`;
}

/** The markup for one chip: its token, hidden, and its label (data-label) drawn by CSS. */
export function chipHtml(token: string, target: BlockLinkTarget, label: LabelChip): string {
  const shown = label(target);
  if (target.type === 'event') return meetingHtml(token, shown);
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
  return `<span ${attributesHtml(attributes)}><span class="n-chip-raw">${escapeHtml(token)}</span></span>`;
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
