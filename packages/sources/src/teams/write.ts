import {
  type ChatDetail,
  type ChatMessage,
  type ChatReply,
  chatFlags,
  chatReply,
  latestFromOthers,
  MESSAGE_FIELD,
  READ_FIELD,
} from '@commander/domain';
import { type Superseded, WriteRejected, type WriteRequest, type WriteResult } from '../source';
import { ChatUnreadable, type Graph, GraphRefused } from './graph';
import { teamsHtml, teamsText } from './html';
import {
  type GraphChat,
  type GraphMessage,
  graphChat,
  graphMessage,
  mergeMessages,
  messagesPage,
  toChatItem,
  toMessage,
} from './shapes';

// Teams's write side (Two-way sync, #106): one Chat's queued changes at a time, as the User.
//
// 1. Read the Chat as Teams has it now (its read time for the User, and its latest message).
// 2. `read`: the newer change wins. Teams already having it that way sends nothing; a read time in
//    Teams newer than the User's change supersedes it. Otherwise `markChatReadForUser`, or
//    `markChatUnreadForUser` from the latest message someone else sent, both for the User (their id
//    and tenant, from the Account).
// 3. `message:<clientId>`: `POST /chats/{id}/messages` with the reply's text as escaped HTML. Graph
//    takes no idempotency key, so a change whose earlier attempt has an unknown outcome (it timed
//    out, the connection dropped, Commander quit mid-way) first reads the Chat's newest messages,
//    and counts as sent if one from the User with the same text was created since that attempt.
// 4. Hand back the Chat as Commander holds it with the sent messages added (under Teams's ids) and
//    Teams's read time, to save at once; the refresh after the write fetches anything else.

// How far Teams's clock may be behind this machine's when matching a reply to an earlier attempt.
export const CLOCK_SKEW_MS = 60_000;
// The most newest messages read back when looking for an earlier attempt.
const NEWEST = 50;

// Who the User is in Teams, as Graph names them for read state: from the Account (keyed
// `teams:<tenant>:<user id>` when signed in).
export function teamsUserOf(account: string, me: string | null | undefined) {
  const match = /^teams:([^:]+):(.+)$/.exec(account);
  if (!match?.[1] || !match[2]) return null;
  return { id: me || match[2], tenantId: match[1] };
}

const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);
const iso = (time: number) => new Date(time).toISOString();
const encode = (chatId: string) => encodeURIComponent(chatId);

type Preview = NonNullable<GraphChat['lastMessagePreview']>;
// The Chat's latest message, when someone other than the User sent it.
const previewFromOthers = (chat: GraphChat, me: string): Preview | null => {
  const preview = chat.lastMessagePreview;
  if (!preview || preview.isDeleted || !preview.from?.user?.id || preview.from.user.id === me) return null;
  return preview;
};

// Whether Teams has the Chat read for the User: no message from anyone else after their read time,
// among the messages Commander holds and the latest one Teams lists.
function readInTeams(chat: GraphChat, stored: ChatDetail | null, me: string): boolean {
  const readAt = at(chat.viewpoint?.lastMessageReadDateTime);
  const preview = previewFromOthers(chat, me);
  if (preview && (readAt === null || Date.parse(preview.createdDateTime) > readAt)) return false;
  return !stored || chatFlags({ messages: stored.messages, lastReadAt: readAt }, me).unreadCount === 0;
}

// Where marking the Chat unread starts: just before the latest message someone else sent.
function unreadFrom(chat: GraphChat, stored: ChatDetail | null, me: string): number | null {
  const times = [
    latestFromOthers(stored?.messages ?? [], me)?.createdAt ?? null,
    at(previewFromOthers(chat, me)?.createdDateTime),
  ].filter((time): time is number => time !== null);
  return times.length ? Math.max(...times) - 1 : null;
}

const sameWords = (message: GraphMessage, reply: ChatReply) =>
  teamsText(message.body?.content ?? '', message.body?.contentType === 'text' ? 'text' : 'html') ===
  teamsText(teamsHtml(reply.text));

// Teams's own copy of a reply an earlier attempt sent, if it got there: the User's message with the
// same text, created since that attempt began.
async function alreadySent(
  graph: Graph,
  chatId: string,
  reply: ChatReply,
  me: string,
  attemptedAt: number,
): Promise<ChatMessage | null> {
  const since = attemptedAt - CLOCK_SKEW_MS;
  const orderby = encodeURIComponent('lastModifiedDateTime desc');
  const filter = encodeURIComponent(`lastModifiedDateTime gt ${iso(since)}`);
  const path = `/chats/${encode(chatId)}/messages?$top=${NEWEST}&$orderby=${orderby}&$filter=${filter}`;
  const { value } = await graph.get(path, messagesPage, chatId);
  const found = value.find(
    (message) =>
      message.from?.user?.id === me &&
      !message.deletedDateTime &&
      Date.parse(message.createdDateTime) >= since &&
      sameWords(message, reply),
  );
  return found ? toMessage(found) : null;
}

// Graph's refusals of a write, in the User's words: trying again won't help.
function refused(error: unknown, posting: 'reply' | 'read'): unknown {
  if (error instanceof ChatUnreadable) {
    return new WriteRejected(
      error.status === 404
        ? 'This Chat is no longer in Teams.'
        : posting === 'reply'
          ? 'Teams won’t let you post in this Chat.'
          : 'Teams won’t let Commander change this Chat.',
    );
  }
  if (error instanceof GraphRefused) {
    return new WriteRejected(
      posting === 'reply' ? 'Teams refused this reply.' : 'Teams refused this change.',
    );
  }
  return error;
}

export async function writeChat(
  graph: Graph,
  request: WriteRequest,
  messagesPerChat: number,
): Promise<Omit<WriteResult, 'cost'>> {
  const chatId = request.externalId;
  const user = teamsUserOf(request.account, request.me);
  if (!user) throw new WriteRejected('Commander can’t tell who you are in this Teams Account.');
  const kept = request.stored?.([chatId]).find((item) => item.externalId === chatId)?.detail;
  const stored = kept?.kind === 'chat' ? kept : null;
  const chatNow = () =>
    graph.get(`/chats/${encode(chatId)}?$expand=lastMessagePreview`, graphChat, chatId).catch((error) => {
      throw refused(error, 'read');
    });

  let chat = await chatNow();
  const superseded: Superseded[] = [];
  const sent: ChatMessage[] = [];
  let readChanged = false;
  for (const change of request.changes) {
    if (change.field === READ_FIELD) {
      if (typeof change.value !== 'boolean' || readInTeams(chat, stored, user.id) === change.value) continue;
      const readAt = at(chat.viewpoint?.lastMessageReadDateTime);
      if (readAt !== null && readAt > change.madeAt) {
        superseded.push({ field: change.field, by: null, at: readAt });
        continue;
      }
      const from = change.value ? null : unreadFrom(chat, stored, user.id);
      // Nothing from anyone else to leave unread.
      if (!change.value && from === null) continue;
      const path = `/chats/${encode(chatId)}/${change.value ? 'markChatReadForUser' : 'markChatUnreadForUser'}`;
      const body = from === null ? { user } : { user, lastMessageReadDateTime: iso(from) };
      await graph.post(path, body, chatId).catch((error) => {
        throw refused(error, 'read');
      });
      readChanged = true;
    } else if (change.field.startsWith(MESSAGE_FIELD)) {
      // Taken back before it went: nothing to send.
      if (change.value === null) continue;
      const reply = chatReply.safeParse(change.value);
      if (!reply.success) throw new WriteRejected('Commander couldn’t make sense of this reply.');
      const earlier =
        change.attemptedAt != null
          ? await alreadySent(graph, chatId, reply.data, user.id, change.attemptedAt)
          : null;
      if (earlier) {
        sent.push(earlier);
        continue;
      }
      const posted = await graph
        .post(
          `/chats/${encode(chatId)}/messages`,
          { body: { contentType: 'html', content: teamsHtml(reply.data.text) } },
          chatId,
          graphMessage,
        )
        .catch((error) => {
          throw refused(error, 'reply');
        });
      if (posted) sent.push(toMessage(posted));
    }
  }
  if (readChanged) chat = await chatNow();
  // Without the Chat's messages as Commander holds them, the refresh after the write saves it.
  if (!stored) return { item: null, superseded };
  const messages = mergeMessages(stored.messages, sent, messagesPerChat);
  return { item: toChatItem(chat, stored.members, messages, user.id), superseded };
}
