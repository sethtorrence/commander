import { z } from 'zod';

/*
  `[[` links in a Block's text. Choosing a target in the `[[` picker writes a token into the Block's
  text where the chip sits, and the Item store keeps a refers-to Link for each token (ADR 0002): the
  token says where the chip is, the Link is what backlinks, "Mentioned in" and everything else read.

  - A day is `[[YYYY-MM-DD]]`: a day never changes, and it reads well as it is.
  - A Project is `[[project:<id>]]`: by id, so renaming or recoding the Project never breaks it. Show
    it through labelBlockLinks (the chip, the Markdown copy's `[[Project name]]`).
  - A calendar event is `[[event:<item id>]]`: shown as a compact live card (time, title, calendar
    colour, its meeting link and Badge), read from the event as it is now. A Block that starts with
    one is a **meeting chip** (meetingChipEventId): the Notes of that meeting go under it, and it takes
    the event's Project. Today's Daily Note gets one for each of today's meetings (#128).

  Tokens are plain text, so they sit inside Markdown formatting (`**see [[2026-10-01]]**`) and come
  through copying and pasting. Anything else in double brackets is just text.
*/

export type BlockLinkTarget =
  | { type: 'day'; day: string }
  | { type: 'project'; projectId: string }
  | { type: 'event'; eventId: string };

export interface BlockLinkTokenAt {
  target: BlockLinkTarget;
  /** Where the token starts and ends in the text (end exclusive). */
  start: number;
  end: number;
}

const TOKEN = /\[\[(?:(\d{4}-\d{2}-\d{2})|project:([0-9A-Za-z-]+)|event:([0-9A-Za-z-]+))\]\]/g;
const LEADING_EVENT = /^\s*\[\[event:([0-9A-Za-z-]+)\]\]/;
const calendarDay = z.iso.date();

/** The token for a target, as it is stored in the Block's text. */
export function blockLinkToken(target: BlockLinkTarget): string {
  switch (target.type) {
    case 'day':
      return `[[${target.day}]]`;
    case 'project':
      return `[[project:${target.projectId}]]`;
    case 'event':
      return `[[event:${target.eventId}]]`;
  }
}

/** Every `[[` link token in a Block's text, in order. */
export function blockLinksIn(text: string): BlockLinkTokenAt[] {
  const found: BlockLinkTokenAt[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const [whole, day, projectId, eventId] = match;
    const start = match.index;
    if (day !== undefined && !calendarDay.safeParse(day).success) continue;
    const target: BlockLinkTarget =
      day !== undefined
        ? { type: 'day', day }
        : projectId !== undefined
          ? { type: 'project', projectId }
          : { type: 'event', eventId: eventId as string };
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

/** The event a meeting chip is for: the Block's text starts with an event's token. Null otherwise. */
export function meetingChipEventId(text: string): string | null {
  return LEADING_EVENT.exec(text)?.[1] ?? null;
}
