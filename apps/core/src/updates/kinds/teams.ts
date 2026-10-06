// Update lines from Teams (#109, #186): a busy Chat. It names the Chat, says how busy it has been and
// who did the talking, and whether anyone is waiting on the User (Ares's "Waiting on you"), in which
// case Reply opens the Chat at that message. Ares's summary of what was said, when he can make one,
// is written alongside (../teams.ts); a channel post's line (#111) goes here too.
import { type ChatDetail, type Item, isSpoken } from '@commander/domain';
import type { LineContext, LineKind } from './types';
import { listed, namedWhere, oneLine, plural } from './words';

type Chat = Item & { detail: ChatDetail };
const chatOf = (item: Item | null): Chat | null =>
  item?.kind === 'chat' && item.detail?.kind === 'chat' ? (item as Chat) : null;

/** Who wrote most of a Chat's messages since a moment, other than the User: up to two names. */
export function mostlyFrom(chat: Chat, since: number, context: LineContext): string[] {
  const me = chat.account ? context.me(chat.account) : null;
  const counts = new Map<string, number>();
  for (const message of chat.detail.messages) {
    if (!isSpoken(message) || message.createdAt <= since || !message.from) continue;
    if (me !== null && message.from.userId === me) continue;
    const name = oneLine(message.from.name);
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => name);
}

export const chatLines: LineKind<'chat-summary'> = {
  name: 'a busy Teams Chat',
  template({ about }, context) {
    const chat = chatOf(context.item(about.itemId));
    const name = chat ? namedWhere(chat) : 'A Teams Chat';
    const busy = `${name} has been busy: ${plural(about.count, 'message')} since your last Update`;
    if (chat?.waiting)
      return `${busy}. ${oneLine(chat.waiting.reason).replace(/[.!?…]+$/, '')}, so it’s waiting on your reply.`;
    const who = chat ? mostlyFrom(chat, about.since, context) : [];
    return `${busy}${who.length ? `, mostly from ${listed(who)}` : ''}. I don’t see anyone waiting on you; open it if you want to catch up.`;
  },
  facts: ({ about }) => [
    `Messages from others since the User's last Update: ${about.count}`,
    'What to do: nothing unless someone is waiting on the User; open it to catch up.',
  ],
  row({ about }, itemId, context) {
    if (itemId !== about.itemId) return null;
    const chat = chatOf(context.item(itemId));
    const messages = plural(about.count, 'message');
    if (chat?.waiting) {
      return {
        state: `${messages} · waiting on you`,
        focus: chat.waiting.messageId,
        actions: ['reply'],
        more: [`Waiting on the User: ${oneLine(chat.waiting.reason)}`],
      };
    }
    return { state: messages, actions: ['open'] };
  },
  // Worded when the Update is put together, from the Chat itself (../teams.ts).
  apart: true,
  guidance: '',
};
