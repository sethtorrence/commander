import { type BlockLinkTarget, blockLinksIn, blockLinkToken, type Project } from '@commander/domain';
import { longDate, weekday } from '../sections/notes/days';
import { shortDay } from './link-targets';

/*
  `[[` links in a Block's text, as the editor sees them: the `[[` being typed, putting a chosen
  target's token in its place, deleting a chip whole, and what a chip says. The tokens themselves are
  defined in @commander/domain (block-links.ts).
*/

/** The `[[` being typed: where it starts, and what has been typed after it. */
export interface LinkQuery {
  start: number;
  query: string;
}

// The longest query the picker stays open for: past that, the `[[` was meant as text.
const MOST = 40;

/** The `[[` the caret is in, if any: from an unfinished `[[` up to the caret. */
export function linkQueryAt(text: string, caret: number): LinkQuery | null {
  const before = text.slice(0, caret);
  const match = /\[\[([^[\]\n]*)$/.exec(before);
  if (!match || match[1] === undefined || match[1].length > MOST) return null;
  const start = match.index;
  // Inside or at the end of a finished token is not typing a new one.
  if (blockLinksIn(text).some((token) => token.start <= start && start < token.end)) return null;
  return { start, query: match[1] };
}

/** The text with the typed `[[query` replaced by the target's token, and the caret just after it. */
export function insertLink(text: string, at: LinkQuery, target: BlockLinkTarget) {
  const token = blockLinkToken(target);
  const end = at.start + 2 + at.query.length;
  return { text: text.slice(0, at.start) + token + text.slice(end), caret: at.start + token.length };
}

/**
 * Backspace just after a chip, or Delete just before one, takes the whole token: the text without it
 * and the caret where it was. Null when the caret isn't at a chip.
 */
export function removeLinkAt(text: string, caret: number, direction: 'backward' | 'forward') {
  const token = blockLinksIn(text).find((t) => (direction === 'backward' ? t.end : t.start) === caret);
  if (!token) return null;
  return { text: text.slice(0, token.start) + text.slice(token.end), caret: token.start };
}

export interface TextPart {
  text: string;
  /** Set for a link token. */
  target?: BlockLinkTarget;
}

/** A Block's text as runs of plain text and link tokens, in order. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let at = 0;
  for (const token of blockLinksIn(text)) {
    if (token.start > at) parts.push({ text: text.slice(at, token.start) });
    parts.push({ text: text.slice(token.start, token.end), target: token.target });
    at = token.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

export interface ChipLabelContext {
  today: string;
  projectById(projectId: string): Project | undefined;
}

export interface ChipLabel {
  text: string;
  /** Its tooltip: what it is and where clicking goes. */
  title: string;
  /** For a Project chip, to show its Badge. */
  project?: Project;
}

/** How chips are labelled where they are shown. */
export type LabelChip = (target: BlockLinkTarget) => ChipLabel;

/** What a chip shows: "Thu 1 Oct", or the Project's name with its Badge. */
export function chipLabel(target: BlockLinkTarget, { today, projectById }: ChipLabelContext): ChipLabel {
  if (target.type === 'day') {
    const { day } = target;
    return { text: shortDay(day, today), title: `${weekday(day)} ${longDate(day)}: go to its Daily Note` };
  }
  const project = projectById(target.projectId);
  if (!project) return { text: 'Unknown Project', title: 'This Project no longer exists' };
  return { text: project.name, title: `${project.name}: open its Project page`, project };
}
