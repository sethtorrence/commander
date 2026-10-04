import { githubIdentifier, type Item } from '@commander/domain';

// What search reads of an Item: its title, its identifier (a Linear issue's ENG-418, a Daily Note's
// day, a pull request's or GitHub issue's acme/api#12) and the rest of its words (a Chat's: its recent
// messages; an event's: its location, attendees and description; a pull request's or issue's body; a
// release's notes; an email's: who it's from and to, its attachments' names and its text). Search by
// meaning (#73) embeds the same text.

// A Chat's messages that search reads, newest kept.
export const CHAT_MESSAGES_SEARCHED = 50;

// An email's body text searched, from its start.
export const EMAIL_TEXT_SEARCHED = 20_000;

export type SearchableItem = Pick<
  Item,
  'id' | 'kind' | 'account' | 'title' | 'filing' | 'detail' | 'updatedAt' | 'deletedAt'
> & {
  // An email's body text, kept beside the Item rather than in its detail (the search module reads it).
  bodyText?: string | null;
};

export type SearchText = { title: string; identifier: string; body: string };

/**
 * The Item's searchable text, or null when it has none or shouldn't be found (a tombstone, or Ares's
 * meeting prep, shown with its meeting rather than on its own, or his GitHub summary, in the GitHub Section).
 */
export function searchTextOf(item: SearchableItem): SearchText | null {
  if (item.deletedAt !== null || item.kind === 'meeting-prep' || item.kind === 'github-summary') return null;
  const detail = item.detail;
  let identifier = '';
  let body = '';
  if (detail?.kind === 'linear-issue') {
    identifier = detail.identifier.toUpperCase();
    body = [detail.description ?? '', ...detail.comments.map((comment) => comment.body)]
      .filter(Boolean)
      .join('\n');
  } else if (detail?.kind === 'daily-note') {
    identifier = detail.day;
  } else if (detail?.kind === 'event') {
    const people = [detail.organiser, ...detail.attendees].flatMap((person) =>
      person ? [person.name ?? '', person.email] : [],
    );
    body = [detail.location ?? '', ...people, detail.description ?? ''].filter(Boolean).join('\n');
  } else if (detail?.kind === 'pull-request' || detail?.kind === 'github-issue') {
    identifier = githubIdentifier(detail.repo, detail.number);
    body = detail.body;
  } else if (detail?.kind === 'github-release') {
    identifier = detail.tag;
    body = detail.notes;
  } else if (detail?.kind === 'chat') {
    body = detail.messages
      .slice(-CHAT_MESSAGES_SEARCHED)
      .filter((message) => !message.deleted && message.text)
      .map((message) => message.text)
      .join('\n');
  } else if (detail?.kind === 'email') {
    // Who it's from and to, its attachments' names and its text (the subject is its title).
    const addresses = [detail.from, ...detail.to, ...detail.cc].flatMap((address) =>
      address ? [address.name ?? '', address.address] : [],
    );
    body = [
      ...addresses,
      ...detail.attachments.map((attachment) => attachment.name),
      (item.bodyText ?? '').slice(0, EMAIL_TEXT_SEARCHED),
    ]
      .filter(Boolean)
      .join('\n');
  }
  const title = item.title.trim();
  if (!title && !identifier && !body) return null;
  return { title, identifier, body };
}

/** Text as exact matches compare it: trimmed, single-spaced, lower-case. */
export const exactKey = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
