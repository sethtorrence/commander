import { z } from 'zod';

/*
  `[[` links in a Block's text. Choosing a target in the `[[` picker writes a token into the Block's
  text where the chip sits, and the Item store keeps a refers-to Link for each token (ADR 0002): the
  token says where the chip is, the Link is what backlinks, "Mentioned in" and everything else read.

  - A day is `[[YYYY-MM-DD]]`: a day never changes, and it reads well as it is.
  - A Project is `[[project:<id>]]`: by id, so renaming or recoding the Project never breaks it. Show
    it through labelBlockLinks (the chip, the Markdown copy's `[[Project name]]`).

  Tokens are plain text, so they sit inside Markdown formatting (`**see [[2026-10-01]]**`) and come
  through copying and pasting. Anything else in double brackets is just text.
*/

export type BlockLinkTarget = { type: 'day'; day: string } | { type: 'project'; projectId: string };

export interface BlockLinkTokenAt {
  target: BlockLinkTarget;
  /** Where the token starts and ends in the text (end exclusive). */
  start: number;
  end: number;
}

const TOKEN = /\[\[(?:(\d{4}-\d{2}-\d{2})|project:([0-9A-Za-z-]+))\]\]/g;
const calendarDay = z.iso.date();

/** The token for a target, as it is stored in the Block's text. */
export function blockLinkToken(target: BlockLinkTarget): string {
  return target.type === 'day' ? `[[${target.day}]]` : `[[project:${target.projectId}]]`;
}

/** Every `[[` link token in a Block's text, in order. */
export function blockLinksIn(text: string): BlockLinkTokenAt[] {
  const found: BlockLinkTokenAt[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const [whole, day, projectId] = match;
    const start = match.index;
    if (day !== undefined && !calendarDay.safeParse(day).success) continue;
    const target: BlockLinkTarget =
      day !== undefined ? { type: 'day', day } : { type: 'project', projectId: projectId as string };
    found.push({ target, start, end: start + whole.length });
  }
  return found;
}

/** The text with each token replaced by its label: `[[Longtail]]` for the Markdown copy, say. */
export function labelBlockLinks(text: string, label: (target: BlockLinkTarget) => string): string {
  let out = '';
  let at = 0;
  for (const token of blockLinksIn(text)) {
    out += text.slice(at, token.start) + label(token.target);
    at = token.end;
  }
  return out + text.slice(at);
}
