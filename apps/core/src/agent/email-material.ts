// An email as Ares reads it in the jobs that look for what mail asks of the User (#144): its headers
// (from, to, cc, date, subject) and its text with quoted history left out, cut to a budget. Never its
// HTML, never its attachments (ADR 0004). Everything in it is someone else's words: the prompt builder
// puts it in an outside data block of its own, by the email Item's origin.
import type { EmailAddress, EmailDetail, Item } from '@commander/domain';
import type { ItemStore } from '../item-store';
import { clockTime, longDay } from './chat-material';
import { trimmedText } from './sort-into-buckets';

const MAX_ADDRESSES = 6;

const addressText = (address: EmailAddress) => {
  const name = address.name?.trim();
  return name && name !== address.address ? `${name} <${address.address}>` : address.address;
};

/** A list of addresses as a header shows them, the first few by name. */
export function addressesText(list: readonly EmailAddress[]): string {
  const shown = list.slice(0, MAX_ADDRESSES).map(addressText);
  const more = list.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

export const emailOf = (item: Item | null | undefined): EmailDetail | null =>
  item?.detail?.kind === 'email' ? item.detail : null;

/** An email's headers and text, its text cut to `budget` characters. */
export function emailText(itemStore: Pick<ItemStore, 'emailBody'>, item: Item, budget: number): string {
  const email = emailOf(item);
  if (!email) return `Title: ${item.title}`;
  const text = itemStore.emailBody(item.id)?.text ?? email.snippet;
  const files = email.attachments.filter((attachment) => !attachment.inline).length;
  return [
    `From: ${email.from ? addressText(email.from) : '(unknown sender)'}`,
    ...(email.to.length ? [`To: ${addressesText(email.to)}`] : []),
    ...(email.cc.length ? [`Cc: ${addressesText(email.cc)}`] : []),
    `Date: ${longDay(email.sentAt)}, ${clockTime(email.sentAt)}`,
    `Subject: ${email.subject || '(no subject)'}`,
    ...(files ? [`Attachments: ${files} (not shown)`] : []),
    `Text: ${trimmedText(text, budget) || '(no text)'}`,
  ].join('\n');
}
