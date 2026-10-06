import type { IncomingMessage, ServerResponse } from 'node:http';

// Teams' teams and channels as the fake Microsoft Graph serves them (fake-microsoft-server.ts), for
// Channel posts (#111), tests only: `GET /me/joinedTeams`, a team's channels, a channel's posts with
// their replies (`$top`, `$expand=replies`, paged with nextLinks, sorted by the last change anywhere in
// the thread as Graph sorts them), a post's replies, and replying to a post. Reading posts needs the
// token to carry ChannelMessage.Read.All and replying ChannelMessage.Send: without, Graph's 403
// "Missing scope permissions" answer, as before an administrator approved them. Nothing here talks to
// the real Microsoft.

export type FakeChannelUser = { id: string; displayName: string };

export type FakeChannelMessage = {
  id: string;
  from: FakeChannelUser;
  html: string;
  createdAt: number;
  modifiedAt: number;
  subject: string | null;
  deleted: boolean;
  // Users it @mentions (each <at id="n"> in the HTML, in order).
  mentions: FakeChannelUser[];
  replies: FakeChannelMessage[];
};

export type FakeChannel = { id: string; name: string; posts: FakeChannelMessage[] };
export type FakeTeam = { id: string; name: string; channels: FakeChannel[] };

export type FakeTeamsChannels = {
  // A team every signed-in user is in, with its channels.
  addTeam(team: { id: string; name: string; channels: { id: string; name: string }[] }): void;
  // Posts in a channel; returns the post's id.
  post(
    teamId: string,
    channelId: string,
    from: FakeChannelUser,
    html: string,
    options?: { at?: number; subject?: string; mentions?: FakeChannelUser[] },
  ): string;
  // Replies to a post; returns the reply's id.
  reply(
    teamId: string,
    channelId: string,
    postId: string,
    from: FakeChannelUser,
    html: string,
    options?: { at?: number; mentions?: FakeChannelUser[] },
  ): string;
  // A channel as the fake holds it.
  channel(teamId: string, channelId: string): FakeChannel;
  // Every reply posted through Graph: its path (decoded) and JSON body.
  replyPosts: { path: string; body: Record<string, unknown> }[];
  handles(url: URL): boolean;
  handle(
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
    user: FakeChannelUser,
    scope: string,
  ): void;
};

const READ = 'channelmessage.read.all';
const SEND = 'channelmessage.send';

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const granted = (scope: string, wanted: string) =>
  scope
    .toLowerCase()
    .split(/\s+/)
    .some((each) => each.replace(/^https:\/\/graph\.microsoft\.com\//, '') === wanted);

export function createFakeTeamsChannels(graphUrl: () => string, tenantId: string): FakeTeamsChannels {
  const teams: FakeTeam[] = [];
  let count = 0;
  const iso = (time: number) => new Date(time).toISOString();
  const nextId = (at: number) => String(at + ++count);

  const channelOf = (teamId: string, channelId: string) => {
    const channel = teams.find((team) => team.id === teamId)?.channels.find((each) => each.id === channelId);
    if (!channel) throw new Error(`No fake channel ${teamId}/${channelId}`);
    return channel;
  };

  const message = (
    from: FakeChannelUser,
    html: string,
    at: number,
    mentions: FakeChannelUser[],
    subject: string | null,
  ): FakeChannelMessage => ({
    id: nextId(at),
    from,
    html,
    createdAt: at,
    modifiedAt: at,
    subject,
    deleted: false,
    mentions,
    replies: [],
  });

  const changedAt = (post: FakeChannelMessage) =>
    Math.max(post.modifiedAt, ...post.replies.map((reply) => reply.modifiedAt));

  function toGraph(teamId: string, channelId: string, each: FakeChannelMessage, replyTo: string | null) {
    return {
      id: each.id,
      replyToId: replyTo,
      messageType: 'message',
      createdDateTime: iso(each.createdAt),
      lastModifiedDateTime: iso(each.modifiedAt),
      lastEditedDateTime: null,
      deletedDateTime: each.deleted ? iso(each.modifiedAt) : null,
      subject: replyTo ? null : each.subject,
      webUrl: `https://teams.microsoft.com/l/message/${encodeURIComponent(channelId)}/${each.id}?groupId=${teamId}&tenantId=${tenantId}`,
      from: { application: null, device: null, user: { ...each.from, userIdentityType: 'aadUser' } },
      body: { contentType: 'html', content: each.deleted ? '' : each.html },
      channelIdentity: { teamId, channelId },
      attachments: [],
      mentions: each.mentions.map((mentioned, index) => ({
        id: index,
        mentionText: mentioned.displayName,
        mentioned: { user: { ...mentioned, userIdentityType: 'aadUser' } },
      })),
      reactions: [],
    };
  }

  // One page of a collection: `$top` at a time, `$skiptoken` saying where the next page starts.
  function paged(
    response: ServerResponse,
    url: URL,
    all: unknown[],
    extra?: (value: unknown[]) => unknown[],
  ) {
    const top = Math.min(50, Number(url.searchParams.get('$top') ?? 20) || 20);
    const start = Number(url.searchParams.get('$skiptoken') ?? 0) || 0;
    const value = all.slice(start, start + top);
    const next = new URL(`${graphUrl()}${url.pathname.slice('/v1.0'.length)}`);
    for (const [name, each] of url.searchParams) if (name !== '$skiptoken') next.searchParams.set(name, each);
    next.searchParams.set('$skiptoken', String(start + top));
    return json(response, 200, {
      value: extra ? extra(value) : value,
      ...(start + top < all.length ? { '@odata.nextLink': next.toString() } : {}),
    });
  }

  const missingScope = (response: ServerResponse, wanted: string) =>
    json(response, 403, {
      error: {
        code: 'Forbidden',
        message: `Missing scope permissions on the request. API requires one of '${wanted}, Group.Read.All, Group.ReadWrite.All'. Roles on the request ''.`,
      },
    });

  const fake: FakeTeamsChannels = {
    replyPosts: [],

    addTeam({ id, name, channels }) {
      teams.push({ id, name, channels: channels.map((channel) => ({ ...channel, posts: [] })) });
    },

    post(teamId, channelId, from, html, { at = Date.now(), subject, mentions = [] } = {}) {
      const posted = message(from, html, at, mentions, subject ?? null);
      channelOf(teamId, channelId).posts.push(posted);
      return posted.id;
    },

    reply(teamId, channelId, postId, from, html, { at = Date.now(), mentions = [] } = {}) {
      const post = channelOf(teamId, channelId).posts.find((each) => each.id === postId);
      if (!post) throw new Error(`No fake post ${postId}`);
      const reply = message(from, html, at, mentions, null);
      post.replies.push(reply);
      return reply.id;
    },

    channel: channelOf,

    handles(url) {
      return url.pathname === '/v1.0/me/joinedTeams' || url.pathname.startsWith('/v1.0/teams/');
    },

    handle(request, url, response, user, scope) {
      if (url.pathname === '/v1.0/me/joinedTeams') {
        return json(response, 200, { value: teams.map((team) => ({ id: team.id, displayName: team.name })) });
      }
      const match = /^\/v1\.0\/teams\/([^/]+)\/channels(?:\/([^/]+)\/messages(?:\/([^/]+)\/replies)?)?$/.exec(
        url.pathname,
      );
      const team = match && teams.find((each) => each.id === decodeURIComponent(match[1] ?? ''));
      if (!match || !team)
        return json(response, 404, { error: { code: 'NotFound', message: 'No such team.' } });
      const [, , rawChannel, rawPost] = match;
      if (rawChannel === undefined) {
        return paged(
          response,
          url,
          team.channels.map((channel) => ({
            id: channel.id,
            displayName: channel.name,
            membershipType: 'standard',
          })),
        );
      }
      const channel = team.channels.find((each) => each.id === decodeURIComponent(rawChannel));
      if (!channel) return json(response, 404, { error: { code: 'NotFound', message: 'No such channel.' } });
      if (request.method === 'POST') {
        if (!rawPost) return json(response, 405, { error: { code: 'MethodNotAllowed' } });
        return void replyThroughGraph(
          request,
          url,
          response,
          user,
          scope,
          team,
          channel,
          decodeURIComponent(rawPost),
        );
      }
      if (!granted(scope, READ)) return missingScope(response, 'ChannelMessage.Read.All');
      if (rawPost !== undefined) {
        const post = channel.posts.find((each) => each.id === decodeURIComponent(rawPost));
        if (!post) return json(response, 404, { error: { code: 'NotFound', message: 'No such post.' } });
        const replies = [...post.replies].sort((a, b) => b.createdAt - a.createdAt);
        return paged(response, url, replies, (value) =>
          (value as FakeChannelMessage[]).map((each) => toGraph(team.id, channel.id, each, post.id)),
        );
      }
      const expand = (url.searchParams.get('$expand') ?? '') === 'replies';
      const posts = [...channel.posts].sort((a, b) => changedAt(b) - changedAt(a));
      return paged(response, url, posts, (value) =>
        (value as FakeChannelMessage[]).map((post) => ({
          ...toGraph(team.id, channel.id, post, null),
          ...(expand
            ? {
                replies: [...post.replies]
                  .sort((a, b) => b.createdAt - a.createdAt)
                  .map((reply) => toGraph(team.id, channel.id, reply, post.id)),
              }
            : {}),
        })),
      );
    },
  };

  async function replyThroughGraph(
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
    user: FakeChannelUser,
    scope: string,
    team: FakeTeam,
    channel: FakeChannel,
    postId: string,
  ) {
    let sent: Record<string, unknown> = {};
    try {
      sent = JSON.parse(await body(request)) as Record<string, unknown>;
    } catch {
      return json(response, 400, { error: { code: 'BadRequest', message: 'Not JSON.' } });
    }
    fake.replyPosts.push({ path: decodeURIComponent(url.pathname), body: sent });
    if (!granted(scope, SEND)) return missingScope(response, 'ChannelMessage.Send');
    const post = channel.posts.find((each) => each.id === postId);
    if (!post) return json(response, 404, { error: { code: 'NotFound', message: 'No such post.' } });
    const content = (sent.body ?? {}) as { contentType?: unknown; content?: unknown };
    if (content.contentType !== 'html' || typeof content.content !== 'string' || !content.content) {
      return json(response, 400, { error: { code: 'BadRequest', message: 'Missing body.' } });
    }
    const reply = message(user, content.content, Date.now(), [], null);
    post.replies.push(reply);
    return json(response, 201, toGraph(team.id, channel.id, reply, post.id));
  }

  return fake;
}
