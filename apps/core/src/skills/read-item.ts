// How an Item found by a Skill goes to a Conversation's model (#192): its facts first (what it is,
// when, who, where it stands, its Project), then its words, cut at a sensible length. Each Item is a
// data block of its own, labelled with its trust by the prompt builder; nothing here decides trust.
// An email reads its text body only (never attachments), a Chat its latest messages, an issue its
// description and latest comments.
import { githubIdentifier, type Item, isSpoken, localDay } from '@commander/domain';
import { clockTime, cut } from '../agent/chat-material';

// How much of an Item's own words go in.
export const MAX_ITEM_TEXT = 2_500;
const MAX_MESSAGES = 30;
const MAX_COMMENTS = 5;
const MAX_MESSAGE = 500;
const MAX_PEOPLE = 10;

export type ReadOptions = {
  // An email's text body, kept beside its Item.
  emailText: (itemId: string) => string | null;
  // A Project's short code, for "Project: TL".
  projectCode: (projectId: string) => string | null;
};

const when = (at: number) => `${localDay(at)} ${clockTime(at)}`;

const KIND_NAMES: Record<Item['kind'], string> = {
  email: 'Email',
  event: 'Calendar event',
  'linear-issue': 'Linear issue',
  'pull-request': 'GitHub pull request',
  'review-request': 'GitHub review request',
  'github-issue': 'GitHub issue',
  'github-release': 'GitHub release',
  chat: 'Teams Chat',
  'channel-post': 'Teams post',
  todo: 'Todo',
  'daily-note': 'Daily Note',
  block: 'Daily Note line',
  'meeting-prep': 'Meeting prep',
  'github-summary': 'GitHub summary',
};

/** What kind of thing an Item is, in plain words: "Email", "Linear issue". */
export const kindName = (item: Pick<Item, 'kind'>) => KIND_NAMES[item.kind];

const people = (names: readonly string[]) => {
  const shown = names.filter(Boolean).slice(0, MAX_PEOPLE);
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
};

/** An Item's facts and words, as one block of material. */
export function readItem(item: Item, options: ReadOptions): string {
  const facts: string[] = [`${kindName(item)}: ${cut(item.title, 300) || '(untitled)'}`];
  const words: string[] = [];
  const detail = item.detail;
  if (detail?.kind === 'email') {
    const from = detail.from ? `${detail.from.name ?? ''} <${detail.from.address}>`.trim() : 'unknown';
    facts.push(
      `From: ${from}`,
      `To: ${people(detail.to.map((to) => to.name || to.address))}`,
      `Sent: ${when(detail.sentAt)}`,
    );
    if (detail.attachments.length)
      facts.push(`Attachments: ${people(detail.attachments.map((file) => file.name))}`);
    words.push(options.emailText(item.id) ?? detail.snippet);
  } else if (detail?.kind === 'event') {
    const start = detail.allDay ? (detail.start.date ?? localDay(detail.start.at)) : when(detail.start.at);
    const end = detail.allDay ? (detail.end.date ?? localDay(detail.end.at)) : clockTime(detail.end.at);
    facts.push(`When: ${start} to ${end}${detail.allDay ? ' (all day)' : ''}`);
    if (detail.location) facts.push(`Where: ${cut(detail.location, 200)}`);
    if (detail.organiser) facts.push(`Organiser: ${detail.organiser.name || detail.organiser.email}`);
    const guests = detail.attendees.filter((attendee) => !attendee.resource && !attendee.self);
    if (guests.length) facts.push(`Guests: ${people(guests.map((guest) => guest.name || guest.email))}`);
    words.push(detail.description ?? '');
  } else if (detail?.kind === 'linear-issue') {
    facts.push(
      `Identifier: ${detail.identifier}`,
      `State: ${detail.state.name}`,
      `Assignee: ${detail.assignee?.name ?? 'nobody'}`,
    );
    if (detail.dueDate) facts.push(`Due: ${detail.dueDate}`);
    if (detail.completedAt) facts.push(`Completed: ${when(detail.completedAt)}`);
    words.push(detail.description ?? '');
    for (const comment of detail.comments.slice(-MAX_COMMENTS)) {
      words.push(
        `${comment.author?.name ?? 'Someone'} (${when(comment.createdAt)}): ${cut(comment.body, MAX_MESSAGE)}`,
      );
    }
  } else if (detail?.kind === 'pull-request' || detail?.kind === 'github-issue') {
    facts.push(
      `Identifier: ${githubIdentifier(detail.repo, detail.number)}`,
      `State: ${detail.state}`,
      `Author: ${detail.author ?? 'unknown'}`,
    );
    if (detail.kind === 'pull-request' && detail.mergedAt) facts.push(`Merged: ${when(detail.mergedAt)}`);
    if (detail.closedAt) facts.push(`Closed: ${when(detail.closedAt)}`);
    words.push(detail.body);
  } else if (detail?.kind === 'github-release') {
    facts.push(`Repo: ${detail.repo.owner}/${detail.repo.name}`, `Tag: ${detail.tag}`);
    words.push(detail.notes);
  } else if (detail?.kind === 'chat') {
    facts.push(`People: ${people(detail.members.map((member) => member.name))}`);
    for (const message of detail.messages.filter(isSpoken).slice(-MAX_MESSAGES)) {
      words.push(
        `${message.from?.name ?? 'Someone'} (${when(message.createdAt)}): ${cut(message.text, MAX_MESSAGE)}`,
      );
    }
  } else if (detail?.kind === 'channel-post') {
    facts.push(`Posted in: ${detail.team.name} / ${detail.channel.name}`);
    for (const message of [detail.post, ...detail.replies.slice(-MAX_MESSAGES)].filter(isSpoken)) {
      words.push(
        `${message.from?.name ?? 'Someone'} (${when(message.createdAt)}): ${cut(message.text, MAX_MESSAGE)}`,
      );
    }
  } else if (detail?.kind === 'todo') {
    facts.push(`Status: ${item.status}`);
    if (detail.dueOn) facts.push(`Due: ${detail.dueOn}`);
  } else if (detail?.kind === 'block') {
    words.push(detail.text);
  } else if (detail?.kind === 'daily-note') {
    facts.push(`Day: ${detail.day}`);
  }
  if (item.kind !== 'todo' && item.kind !== 'block' && item.status !== 'open')
    facts.push(`Status: ${item.status}`);
  const code = item.filing ? options.projectCode(item.filing.projectId) : null;
  if (code) facts.push(`Project: ${code}`);
  facts.push(`Last changed: ${when(item.updatedAt)}`);
  const said = words.filter((each) => each.trim()).join('\n');
  const body = said.length > MAX_ITEM_TEXT ? `${said.slice(0, MAX_ITEM_TEXT).trimEnd()} [cut]` : said;
  return body ? `${facts.join('\n')}\n\n${body}` : facts.join('\n');
}
