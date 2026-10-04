import {
  addressName,
  type BlockLinkTarget,
  blockLinksIn,
  blockLinkToken,
  type Item,
  isEvent,
  meetingStatus,
  meetingStatusText,
  meetingTimes,
  type Project,
} from '@commander/domain';
import { longDate, weekday } from '../sections/notes/days';
import { emailDate, emailSubject, isEmailItem, shortDay } from './link-targets';

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
  /** Calendar events, as Commander holds them (tombstones too), for meeting chips' live cards. */
  eventById?(eventId: string): Item | undefined;
  /** Emails, as Commander holds them (tombstones too), for email chips' live cards. */
  emailById?(emailId: string): Item | undefined;
}

/** An email chip's live card: who sent it, when, and whether Commander still has it. */
export interface EmailCard {
  /** The sender's name, or address. */
  sender: string;
  /** When it came, briefly: "09:15" today, "1 Oct". */
  date: string;
  /** Deleted, or not in Commander: drawn faint and struck through. */
  gone: boolean;
}

/** A meeting chip's live card: its calendar colour, join link and how the meeting stands. */
export interface MeetingCard {
  colour: string;
  /** The online meeting's link, while the meeting is on. */
  joinUrl: string | null;
  /** "Cancelled", "Declined", "Moved to Thu 10:00"; null while it is on. */
  status: string | null;
  /** Cancelled or declined: drawn struck through. */
  struck: boolean;
}

export interface ChipLabel {
  text: string;
  /** Its tooltip: what it is and where clicking goes. */
  title: string;
  /** For a Project chip (or a meeting filed under one), to show its Badge. */
  project?: Project;
  /** For a meeting chip: the rest of its card. */
  meeting?: MeetingCard;
  /** For an email chip: the rest of its card (its text is the subject). */
  email?: EmailCard;
}

/** Where a chip is shown: the day of the Daily Note it is in, which a meeting is read from. */
export interface ChipPlace {
  day: string;
}

/** How chips are labelled where they are shown. */
export type LabelChip = (target: BlockLinkTarget, place?: ChipPlace) => ChipLabel;

/**
 * What a chip shows: "Thu 1 Oct", the Project's name with its Badge, or a meeting's card ("10:00–10:30
 * Weekly sync with Priya", calendar colour, join link, Badge, and whether it was cancelled or moved,
 * read from the day of the note it is in), or an email's card (sender, subject, date and Badge, and
 * whether Commander still has it).
 */
export function chipLabel(
  target: BlockLinkTarget,
  { today, projectById, eventById, emailById }: ChipLabelContext,
  place?: ChipPlace,
): ChipLabel {
  if (target.type === 'email') {
    const email = emailById?.(target.emailId);
    if (!isEmailItem(email)) {
      return {
        text: 'An email',
        title: 'An email Commander doesn’t have',
        email: { sender: '', date: '', gone: true },
      };
    }
    const subject = emailSubject(email.detail);
    const sender = addressName(email.detail.from);
    const date = emailDate(email.detail.sentAt, today);
    const gone = email.deletedAt !== null;
    const project = email.filing ? projectById(email.filing.projectId) : undefined;
    const from = sender ? `, from ${sender}` : '';
    return {
      text: subject,
      title: gone
        ? `${subject}${from}: no longer in Commander`
        : `${subject}${from} on ${date}: open its thread in the Email Section`,
      ...(project && { project }),
      email: { sender, date, gone },
    };
  }
  if (target.type === 'event') {
    const event = eventById?.(target.eventId);
    if (!isEvent(event)) {
      return {
        text: 'A meeting',
        title: 'A calendar event Commander doesn’t have',
        meeting: { colour: 'transparent', joinUrl: null, status: null, struck: false },
      };
    }
    const status = meetingStatus(event, place?.day ?? today);
    const times = event.detail.allDay ? 'All day' : meetingTimes(event.detail);
    const project = event.filing ? projectById(event.filing.projectId) : undefined;
    const struck = status.kind === 'cancelled' || status.kind === 'declined';
    return {
      text: `${times} ${event.title}`,
      title: `${event.title}, ${times} on ${event.detail.calendar.name}: open it in the Calendar Section`,
      ...(project && { project }),
      meeting: {
        colour: event.detail.calendar.colour,
        joinUrl: status.kind === 'on' ? event.detail.meetingUrl : null,
        status: meetingStatusText(status),
        struck,
      },
    };
  }
  if (target.type === 'day') {
    const { day } = target;
    return { text: shortDay(day, today), title: `${weekday(day)} ${longDate(day)}: go to its Daily Note` };
  }
  const project = projectById(target.projectId);
  if (!project) return { text: 'Unknown Project', title: 'This Project no longer exists' };
  return { text: project.name, title: `${project.name}: open its Project page`, project };
}
