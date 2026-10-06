import {
  type ChannelMessage,
  type ChannelReply,
  channelReply,
  parseChannelPostId,
  REPLY_FIELD,
} from '@commander/domain';
import { z } from 'zod';
import { WriteRejected, type WriteRequest, type WriteResult } from '../source';
import { isPermissionRefusal, toChannelMessage, toChannelPostItem } from './channels';
import { ChatUnreadable, type Graph, type GraphPage, GraphRefused } from './graph';
import { teamsHtml, teamsText } from './html';
import { type GraphMessage, graphMessage, mergeMessages } from './shapes';
import { CLOCK_SKEW_MS, teamsUserOf } from './write';

// Replying to a Channel post (#111), as the User: `POST /teams/{t}/channels/{c}/messages/{m}/replies`
// with the reply's text as escaped HTML (`ChannelMessage.Send`, which needs no administrator). As for
// a Chat's replies, Graph takes no idempotency key, so a reply whose earlier attempt has an unknown
// outcome first reads the post's replies, and counts as sent if one from the User with the same text
// was created since that attempt. Hands back the post as Commander holds it with the reply added
// (under Teams's id), to save at once; the refresh after the write fetches anything else.

const NEWEST = 50;
const REPLIES_KEPT = 200;

const repliesPage = z.object({
  value: z.array(graphMessage),
  '@odata.nextLink': z.string().optional(),
}) as unknown as z.ZodType<GraphPage<GraphMessage>>;

const encode = (id: string) => encodeURIComponent(id);

const sameWords = (message: GraphMessage, reply: ChannelReply) =>
  teamsText(message.body?.content ?? '', message.body?.contentType === 'text' ? 'text' : 'html') ===
  teamsText(teamsHtml(reply.text));

function refused(error: unknown): unknown {
  if (isPermissionRefusal(error) || (error instanceof ChatUnreadable && error.status === 403)) {
    return new WriteRejected(
      'Teams won’t let you reply in this channel. If Commander lacks ChannelMessage.Send, use Request access in Settings → Teams.',
    );
  }
  if (error instanceof ChatUnreadable) return new WriteRejected('This post is no longer in Teams.');
  if (error instanceof GraphRefused) return new WriteRejected('Teams refused this reply.');
  return error;
}

export async function writeChannelPost(
  graph: Graph,
  request: WriteRequest,
): Promise<Omit<WriteResult, 'cost'>> {
  const ids = parseChannelPostId(request.externalId);
  if (!ids) throw new WriteRejected('Commander can’t tell which Channel post this is.');
  const user = teamsUserOf(request.account, request.me);
  if (!user) throw new WriteRejected('Commander can’t tell who you are in this Teams Account.');
  const kept = request
    .stored?.([request.externalId])
    .find((item) => item.externalId === request.externalId)?.detail;
  const stored = kept?.kind === 'channel-post' ? kept : null;
  const replies = `/teams/${encode(ids.teamId)}/channels/${encode(ids.channelId)}/messages/${encode(ids.messageId)}/replies`;
  const channelKey = `channel:${ids.channelId}`;

  // Teams's own copy of a reply an earlier attempt sent, if it got there.
  async function alreadySent(reply: ChannelReply, attemptedAt: number): Promise<ChannelMessage | null> {
    const since = attemptedAt - CLOCK_SKEW_MS;
    const { value } = await graph.get(`${replies}?$top=${NEWEST}`, repliesPage, channelKey).catch((error) => {
      throw refused(error);
    });
    const found = value.find(
      (message) =>
        message.from?.user?.id === user?.id &&
        !message.deletedDateTime &&
        Date.parse(message.createdDateTime) >= since &&
        sameWords(message, reply),
    );
    return found ? toChannelMessage(found) : null;
  }

  const sent: ChannelMessage[] = [];
  for (const change of request.changes) {
    if (!change.field.startsWith(REPLY_FIELD)) continue;
    // Taken back before it went: nothing to send.
    if (change.value === null) continue;
    const reply = channelReply.safeParse(change.value);
    if (!reply.success) throw new WriteRejected('Commander couldn’t make sense of this reply.');
    const earlier = change.attemptedAt != null ? await alreadySent(reply.data, change.attemptedAt) : null;
    if (earlier) {
      sent.push(earlier);
      continue;
    }
    const posted = await graph
      .post(
        replies,
        { body: { contentType: 'html', content: teamsHtml(reply.data.text) } },
        channelKey,
        graphMessage,
      )
      .catch((error) => {
        throw refused(error);
      });
    if (posted) sent.push(toChannelMessage(posted));
  }
  // Without the post as Commander holds it, the refresh after the write saves it.
  if (!stored) return { item: null, superseded: [] };
  return {
    item: toChannelPostItem(
      { team: stored.team, channel: stored.channel },
      stored.post,
      mergeMessages(stored.replies, sent, REPLIES_KEPT),
      { subject: stored.subject, webUrl: stored.webUrl },
      user.id,
    ),
    superseded: [],
  };
}
