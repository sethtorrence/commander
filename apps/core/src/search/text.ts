import type { Item } from '@commander/domain';

// What search reads of an Item: its title, its identifier (a Linear issue's ENG-418, a Daily Note's
// day) and the rest of its words (a Chat's: its recent messages; an event's: its location, attendees
// and description). Search by meaning (#73) embeds the
// same text.

// A Chat's messages that search reads, newest kept.
export const CHAT_MESSAGES_SEARCHED = 50;

export type SearchableItem = Pick<
  Item,
  'id' | 'kind' | 'account' | 'title' | 'filing' | 'detail' | 'updatedAt' | 'deletedAt'
>;

export type SearchText = { title: string; identifier: string; body: string };

/** The Item's searchable text, or null when it has none or shouldn't be found (a tombstone). */
export function searchTextOf(item: SearchableItem): SearchText | null {
  if (item.deletedAt !== null) return null;
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
  } else if (detail?.kind === 'chat') {
    body = detail.messages
      .slice(-CHAT_MESSAGES_SEARCHED)
      .filter((message) => !message.deleted && message.text)
      .map((message) => message.text)
      .join('\n');
  }
  const title = item.title.trim();
  if (!title && !identifier && !body) return null;
  return { title, identifier, body };
}

/** Text as exact matches compare it: trimmed, single-spaced, lower-case. */
export const exactKey = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
