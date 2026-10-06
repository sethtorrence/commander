import {
  type ChannelMessage,
  type ChannelPostDetail,
  type ConversationMention,
  channelPostFlags,
  channelPostId,
  isChannelExcluded,
  parseChannelPostId,
  type SourceItem,
  type TeamsCatalog,
} from '@commander/domain';
import { z } from 'zod';
import type { StoredItem, SyncMode, SyncRequest } from '../source';
import { ChatUnreadable, type Graph, type GraphPage } from './graph';
import { type GraphMessage, graphMessage, mergeMessages, toMessage } from './shapes';

// Channel posts (#111): the posts and replies in the channels of the User's teams, once Microsoft
// shares them (`ChannelMessage.Read.All`, approved by an administrator) and the User switched Sync
// Channel posts on. Graph has no delta for channels any more and no push for a desktop app, and
// listing a channel's messages takes no filter (only `$top` and `$expand=replies`), so Commander
// polls, as cheaply and as gently as it can:
//
// - Teams and channels (`/me/joinedTeams`, `/teams/{id}/channels`): listed on the first channel sync
//   and on each full (daily) sync, kept in the cursor and handed over as the Account's catalog for
//   Settings. Channels excluded by the User (alone or with their team) are never read; their posts,
//   and those of channels no longer listed, become tombstones.
// - Per channel: `GET /teams/{t}/channels/{c}/messages?$top=20&$expand=replies`. Graph sorts the
//   threads by the last change anywhere in them (the post or a reply), so Commander reads page by
//   page and stops at the first thread no newer than the newest change it has seen there: a quiet
//   channel costs one request. More replies than a thread's expansion holds are paged
//   (`replies@odata.nextLink`). First sync: threads active in the last 14 days, the newest 100.
// - Each thread is a `channel-post` Item: the post, its replies (the newest 200, merged with those
//   kept), team, channel and links. A deleted post becomes a tombstone; a deleted reply stays,
//   marked deleted, as in Chats.
// - Bounded per sync, so polling channels never crowds out Chats (which sync first and are saved
//   before any channel is read): a full sync reads every channel (up to 200), a light check up to
//   15 that are due (one active in the last week after 10 minutes, a quiet one after 6 hours, a new
//   one at once), oldest checked first, and either stops after its share of requests. Each channel
//   gets at most one request a second (Teams' limit) and channel requests are spaced a little;
//   429s and 503s with Retry-After stop the sync at once, keeping what was done.
// - A 403 saying the permission is missing means consent was withdrawn (or never given): Channel
//   posts stop for this sync and `channelPostsRefused` tells the Core, which tells the main process.

const DAY_MS = 24 * 60 * 60_000;
const FIRST_SYNC_DAYS = 14;
const POSTS_PAGE = 20;
const MAX_PAGES = 5;
const REPLIES_KEPT = 200;
const MAX_REPLY_PAGES = 10;
const ACTIVE_DAYS = 7;
const ACTIVE_RECHECK_MS = 10 * 60_000;
const QUIET_RECHECK_MS = 6 * 60 * 60_000;
const LIST_AGAIN_MS = DAY_MS;
// How many channels one sync reads, and how many requests the channel part of it may make.
export const FULL_CHANNELS = 200;
export const LIGHT_CHANNELS = 15;
const FULL_REQUESTS = 600;
const LIGHT_REQUESTS = 45;
// The least time between two channel requests, whichever channels (Teams' tenant-wide limits).
export const CHANNEL_GAP_MS = 200;

// What the cursor keeps of channels: the teams and channels as last listed, and per channel the
// newest change seen there, when it was last checked and when it was last active.
const channelMark = z.object({ seen: z.number(), checked: z.number(), active: z.number().nullable() });
export type ChannelMark = z.infer<typeof channelMark>;
export const channelsCursor = z.object({
  listedAt: z.number(),
  teams: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      channels: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
  marks: z.record(z.string(), channelMark),
});
export type ChannelsCursor = z.infer<typeof channelsCursor>;

const text = z.string().nullish();
const named = z.object({ id: z.string().min(1), displayName: text });
const page = <T extends z.ZodType>(item: T) =>
  z.object({ value: z.array(item), '@odata.nextLink': z.string().optional() }) as unknown as z.ZodType<
    GraphPage<z.infer<T>>
  >;
const teamsPage = page(named);
const channelsPage = page(named.extend({ membershipType: text }));
const repliesPage = page(graphMessage);
const graphPost = graphMessage.extend({
  subject: text,
  webUrl: text,
  replies: z.array(graphMessage).nullish(),
  'replies@odata.nextLink': text,
});
type GraphPost = z.infer<typeof graphPost>;
const postsPage = z.object({
  value: z.array(graphPost),
  '@odata.nextLink': z.string().optional(),
}) as unknown as z.ZodType<GraphPage<GraphPost>>;

const encode = (id: string) => encodeURIComponent(id);
const keyOf = (teamId: string, channelId: string) => `${teamId}/${channelId}`;
const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : 0);
const isWebLink = (url: string | null | undefined): url is string => !!url && /^https?:\/\//i.test(url);
const changedAt = (message: GraphMessage) => at(message.lastModifiedDateTime ?? message.createdDateTime);
// When anything in a thread last changed: the post, or any reply (Graph's own order for the list).
const threadChangedAt = (post: GraphPost) =>
  Math.max(changedAt(post), ...(post.replies ?? []).map(changedAt));

/** A post or reply as Commander keeps it: a Chat message's shape, with the team and channel mentions. */
export function toChannelMessage(message: GraphMessage): ChannelMessage {
  const converted = toMessage(message);
  const conversations: ConversationMention[] = [];
  for (const mention of message.mentions ?? []) {
    const conversation = mention.mentioned?.conversation;
    const kind = conversation?.conversationIdentityType;
    if (conversation && (kind === 'team' || kind === 'channel'))
      conversations.push({
        kind,
        id: conversation.id ?? '',
        name: conversation.displayName?.trim() || mention.mentionText?.trim() || kind,
      });
  }
  return conversations.length ? { ...converted, conversationMentions: conversations } : converted;
}

type Place = { team: { id: string; name: string }; channel: { id: string; name: string } };

/** A thread as an Item. Its title: the subject, or else the post's first line. */
export function toChannelPostItem(
  place: Place,
  post: ChannelMessage,
  replies: ChannelMessage[],
  extra: { subject: string | null; webUrl: string | null },
  me: string | null,
): SourceItem {
  const firstLine =
    post.text
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? '';
  const title =
    extra.subject ||
    (firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine) ||
    `Post in ${place.channel.name}`;
  const people = [
    ...new Set(
      [post, ...replies].flatMap((message) => (message.from?.userId ? [`teams:${message.from.userId}`] : [])),
    ),
  ];
  const detail: ChannelPostDetail = {
    kind: 'channel-post',
    team: place.team,
    channel: place.channel,
    subject: extra.subject,
    post,
    replies,
    webUrl: isWebLink(extra.webUrl) ? extra.webUrl : null,
    ...channelPostFlags({ post, replies }, me),
  };
  return {
    externalId: channelPostId(place.team.id, place.channel.id, post.id),
    kind: 'channel-post',
    title,
    people,
    status: 'open',
    detail,
  };
}

// Graph's answer when the token lacks the permission to read channel messages, as opposed to a
// channel closed to the User (a private channel they left).
const MISSING_PERMISSION =
  /ChannelMessage\.Read\.All|missing scope|scopes? on the request|insufficient privileges/i;
export const isPermissionRefusal = (error: unknown): boolean =>
  error instanceof ChatUnreadable && error.status === 403 && MISSING_PERMISSION.test(error.said ?? '');

export type ChannelsOptions = {
  graph: Graph;
  request: SyncRequest;
  mode: SyncMode;
  me: string | null;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  previous: ChannelsCursor | null;
  // Called with the channels' cursor as it stands after each channel, so a sync stopped part-way (a
  // rate limit) keeps what it did.
  progress: (cursor: ChannelsCursor) => void;
};

/**
 * Syncs Channel posts, or (switched off, or never granted) hands back the posts Commander still
 * holds as deleted. Returns the channels' cursor for next time, or null when Channel posts are off.
 */
export async function syncChannels({
  graph,
  request,
  mode,
  me,
  now,
  sleep,
  previous,
  progress,
}: ChannelsOptions): Promise<ChannelsCursor | null> {
  const settings = request.channelPosts;
  const heldPosts = () =>
    (request.heldIds?.() ?? []).flatMap((externalId) => {
      const parsed = parseChannelPostId(externalId);
      return parsed ? [{ externalId, ...parsed }] : [];
    });

  if (!settings) {
    const held = heldPosts().map((each) => each.externalId);
    if (held.length) request.save({ items: [], deleted: held });
    return null;
  }

  const started = now();
  let requests = 0;
  const budget = mode === 'full' ? FULL_REQUESTS : LIGHT_REQUESTS;
  let lastRequestAt: number | null = null;
  // Spaces channel requests a little, and counts them against this sync's share.
  const spaced = async <T>(send: () => Promise<T>): Promise<T> => {
    if (lastRequestAt !== null) {
      const wait = lastRequestAt + CHANNEL_GAP_MS - now();
      if (wait > 0) await sleep(wait, request.signal);
    }
    requests += 1;
    try {
      return await send();
    } finally {
      // From when the answer came (the per-channel pacing inside may have waited first).
      lastRequestAt = now();
    }
  };

  // The teams and their channels: listed afresh daily, else as last listed.
  let teams = previous?.teams ?? [];
  let listedAt = previous?.listedAt ?? 0;
  if (!previous || mode === 'full' || started - listedAt >= LIST_AGAIN_MS) {
    const joined = await spaced(() => graph.all('/me/joinedTeams?$select=id,displayName', teamsPage));
    const listed: ChannelsCursor['teams'] = [];
    for (const team of joined) {
      const key = `team:${team.id}`;
      try {
        const channels = await spaced(() =>
          graph.all(
            `/teams/${encode(team.id)}/channels?$select=id,displayName,membershipType`,
            channelsPage,
            {
              chatId: key,
            },
          ),
        );
        listed.push({
          id: team.id,
          name: team.displayName?.trim() || 'Team',
          channels: channels.map((channel) => ({
            id: channel.id,
            name: channel.displayName?.trim() || 'Channel',
          })),
        });
      } catch (error) {
        // A team Teams won't open to the User now: skipped, and its posts kept until it is listed again.
        if (!(error instanceof ChatUnreadable)) throw error;
        const before = previous?.teams.find((each) => each.id === team.id);
        if (before) listed.push(before);
      }
    }
    teams = listed;
    listedAt = started;
    const catalog: TeamsCatalog = { kind: 'teams', teams };
    request.saveCatalog?.(catalog);
  }

  const excluded = settings.excluded;
  const places = teams.flatMap((team) =>
    team.channels
      .filter((channel) => !isChannelExcluded(excluded, team.id, channel.id))
      .map((channel) => ({ team: { id: team.id, name: team.name }, channel })),
  );
  const live = new Set(places.map((place) => keyOf(place.team.id, place.channel.id)));

  // Posts in channels excluded, or no longer listed: tombstones.
  const gone = heldPosts()
    .filter((each) => !live.has(keyOf(each.teamId, each.channelId)))
    .map((each) => each.externalId);
  if (gone.length) request.save({ items: [], deleted: gone });

  const marks: Record<string, ChannelMark> = {};
  for (const [key, mark] of Object.entries(previous?.marks ?? {})) if (live.has(key)) marks[key] = mark;
  const cursor = (): ChannelsCursor => ({ listedAt, teams, marks: { ...marks } });

  // Which channels to read this time, the most overdue first.
  const activeSince = started - ACTIVE_DAYS * DAY_MS;
  const due = places
    .filter((place) => {
      if (mode === 'full') return true;
      const mark = marks[keyOf(place.team.id, place.channel.id)];
      if (!mark) return true;
      const wait = mark.active !== null && mark.active > activeSince ? ACTIVE_RECHECK_MS : QUIET_RECHECK_MS;
      return started - mark.checked >= wait;
    })
    .sort((a, b) => {
      const markA = marks[keyOf(a.team.id, a.channel.id)];
      const markB = marks[keyOf(b.team.id, b.channel.id)];
      return (markA?.checked ?? -1) - (markB?.checked ?? -1);
    })
    .slice(0, mode === 'full' ? FULL_CHANNELS : LIGHT_CHANNELS);

  const firstWindow = started - FIRST_SYNC_DAYS * DAY_MS;
  for (const place of due) {
    if (requests >= budget) break;
    const key = keyOf(place.team.id, place.channel.id);
    const mark = marks[key];
    const since = mark?.seen ?? firstWindow;
    const channelKey = `channel:${place.channel.id}`;
    const base = `/teams/${encode(place.team.id)}/channels/${encode(place.channel.id)}/messages`;
    const changed: GraphPost[] = [];
    let newest = since;
    // Stopped by this sync's share of requests before reaching what was seen: read again next time.
    let unfinished = false;
    try {
      let next: string | undefined = `${base}?$top=${POSTS_PAGE}&$expand=replies`;
      for (let pages = 0; next && pages < MAX_PAGES; pages++) {
        if (requests >= budget) {
          unfinished = true;
          break;
        }
        const link: string = next;
        const answer = await spaced(() => graph.get(link, postsPage, channelKey));
        let reachedSeen = false;
        for (const post of answer.value) {
          const changedTime = threadChangedAt(post);
          if (changedTime <= since) {
            reachedSeen = true;
            break;
          }
          newest = Math.max(newest, changedTime);
          changed.push(post);
        }
        next = reachedSeen ? undefined : answer['@odata.nextLink'];
      }
    } catch (error) {
      if (isPermissionRefusal(error)) {
        request.channelPostsRefused?.();
        return previous;
      }
      // A channel closed to the User now (a private channel they left, or gone): skipped this time.
      if (error instanceof ChatUnreadable) continue;
      throw error;
    }

    const ids = changed.map((post) => channelPostId(place.team.id, place.channel.id, post.id));
    const stored = new Map((request.stored?.(ids) ?? []).map((item) => [item.externalId, item]));
    const items: SourceItem[] = [];
    const deleted: string[] = [];
    for (const post of changed) {
      const externalId = channelPostId(place.team.id, place.channel.id, post.id);
      if (post.deletedDateTime) {
        deleted.push(externalId);
        continue;
      }
      // A system event as a thread of its own (the team's description changed): nothing to keep.
      if (post.messageType === 'systemEventMessage') continue;
      const kept = keptDetail(stored.get(externalId));
      let fetched = (post.replies ?? []).map(toChannelMessage);
      let more = post['replies@odata.nextLink'] ?? undefined;
      // More replies than the expansion held: paged, newest first, until those already kept.
      for (let pages = 0; more && pages < MAX_REPLY_PAGES && requests < budget; pages++) {
        const link: string = more;
        try {
          const answer = await spaced(() => graph.get(link, repliesPage, channelKey));
          fetched = [...fetched, ...answer.value.map(toChannelMessage)];
          const reachedKept = kept !== null && answer.value.some((reply) => changedAt(reply) <= since);
          more = reachedKept || fetched.length >= REPLIES_KEPT ? undefined : answer['@odata.nextLink'];
        } catch (error) {
          if (!(error instanceof ChatUnreadable)) throw error;
          more = undefined;
        }
      }
      const replies = mergeMessages(kept?.replies ?? [], fetched, REPLIES_KEPT);
      const subject = post.subject?.trim() || null;
      items.push(
        toChannelPostItem(
          place,
          toChannelMessage(post),
          replies,
          { subject, webUrl: post.webUrl ?? null },
          me,
        ),
      );
    }
    if (items.length || deleted.length) request.save({ items, deleted });

    const active = [mark?.active ?? null, ...changed.map(threadChangedAt)].reduce<number | null>(
      (a, b) => (b === null ? a : a === null ? b : Math.max(a, b)),
      null,
    );
    // Cut short by the share of requests: the same place next time, first in line (what was read
    // is saved again, harmlessly). Cut short by the page limit: history beyond it isn't fetched.
    marks[key] = unfinished
      ? { seen: since, checked: mark?.checked ?? 0, active }
      : { seen: newest, checked: started, active };
    progress(cursor());
  }
  return cursor();
}

const keptDetail = (item: StoredItem | undefined): ChannelPostDetail | null =>
  item?.detail?.kind === 'channel-post' ? item.detail : null;
