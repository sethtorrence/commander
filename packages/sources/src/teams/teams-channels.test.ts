import type { ChannelPostDetail, SourceCatalog, SourceItem } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AccessToken, RateLimited, type StoredItem, type SyncMode, type SyncPage } from '../source';
import { CHANNEL_GAP_MS, type ChannelsCursor } from './channels';
import { PER_CHAT_GAP_MS } from './graph';
import firstSync from './recorded/channels-first-sync.json';
import later from './recorded/channels-later.json';
import refused from './recorded/channels-refused.json';
import { createTeamsSource, type TeamsCursor, WRITE_TIMEOUT_MS } from './teams-source';

// Channel posts (#111) against recorded Microsoft Graph responses, shaped as Graph answers (with
// `{graph}` standing for Graph's base in the links it gives). Each recording pins down the requests
// Commander must send, in order. The User has no Chats here, so every request after the Chat list is
// about channels.

type Recorded = { status: number; headers: Record<string, string>; body: unknown };
type Exchange = { request: { path: string }; response: Recorded };

const GRAPH = 'https://graph.test/v1.0';
const NOW = Date.UTC(2026, 9, 3, 12);
const HOUR = 60 * 60_000;
const ME = 'u-sam';
const token: AccessToken = { token: 'ms_access_recorded', kind: 'oauth' };

const TL = 'team-tl';
const GENERAL = '19:general-tl@thread.tacv2';
const RELEASES = '19:releases@thread.tacv2';
const OPS_GENERAL = '19:general-ops@thread.tacv2';
const POST_A = `${TL}/${GENERAL}/1790840000000`;
const POST_D = `${TL}/${RELEASES}/1790950000000`;
const POST_E = `${TL}/${GENERAL}/1790990000000`;

let clock: number;
let sent: { path: string; at: number; method: string; body: unknown }[];
let held: Map<string, SourceItem>;
let unexpected: string[];

beforeEach(() => {
  clock = NOW;
  sent = [];
  held = new Map();
  unexpected = [];
});

afterEach(() => {
  expect(unexpected).toEqual([]);
});

function replay(exchanges: Exchange[]) {
  const queue = [...exchanges];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = decodeURIComponent(String(url).slice(GRAPH.length));
    const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    sent.push({ path, at: clock, method: init?.method ?? 'GET', body: payload });
    const next = queue.shift();
    if (next?.request.path !== path) {
      unexpected.push(path);
      throw new Error(`Unexpected request ${path}`);
    }
    const { status, headers, body } = next.response;
    const text = body === null ? '' : JSON.stringify(body).replaceAll('{graph}', GRAPH);
    return new Response(text, { status, headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, remaining: () => queue.length };
}

type Excluded = { teamId: string; channelId: string | null }[];

async function sync(
  fetch: typeof globalThis.fetch,
  {
    cursor = null,
    mode = 'full',
    start = NOW,
    channelPosts = { excluded: [] },
  }: { cursor?: unknown; mode?: SyncMode; start?: number; channelPosts?: { excluded: Excluded } | null } = {},
) {
  const pages: SyncPage[] = [];
  const catalogs: SourceCatalog[] = [];
  const checkpoints: unknown[] = [];
  let refusals = 0;
  clock = start;
  const source = createTeamsSource({
    graphUrl: () => GRAPH,
    fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  const run = source.sync({
    account: 'teams:fake-tenant:u-sam',
    cursor,
    mode,
    me: ME,
    stored: (ids) =>
      ids.flatMap((id): StoredItem[] => {
        const item = held.get(id);
        return item
          ? [{ externalId: id, title: item.title, people: [], status: 'open', detail: item.detail ?? null }]
          : [];
      }),
    heldIds: () => [...held.keys()],
    accessToken: async () => token,
    channelPosts,
    channelPostsRefused: () => {
      refusals += 1;
    },
    checkpoint: (next) => checkpoints.push(next),
    saveCatalog: (catalog) => catalogs.push(catalog),
    save: (page) => {
      pages.push(page);
      for (const item of page.items) held.set(item.externalId, item);
      for (const id of page.deleted) held.delete(id);
    },
    signal: new AbortController().signal,
  });
  return { run, pages, catalogs, checkpoints, refusals: () => refusals };
}

const postOf = (externalId: string) => held.get(externalId)?.detail as ChannelPostDetail | undefined;

async function afterFirstSync(): Promise<TeamsCursor> {
  const { run } = await sync(replay(firstSync as Exchange[]).fetch);
  const { cursor } = await run;
  sent = [];
  return cursor as TeamsCursor;
}

describe('the first sync of Channel posts', () => {
  it('lists the teams and channels, and reads each channel’s threads from the last 14 days', async () => {
    const recorded = replay(firstSync as Exchange[]);
    const { run, catalogs } = await sync(recorded.fetch);
    const { cursor } = await run;
    expect(recorded.remaining()).toBe(0);

    expect(catalogs).toEqual([
      {
        kind: 'teams',
        teams: [
          {
            id: TL,
            name: 'Titanlink',
            channels: [
              { id: GENERAL, name: 'General' },
              { id: RELEASES, name: 'releases' },
            ],
          },
          { id: 'team-ops', name: 'Ops', channels: [{ id: OPS_GENERAL, name: 'General' }] },
        ],
      },
    ]);
    // The system event and the post older than 14 days are left out; the next page isn't read.
    expect([...held.keys()].sort()).toEqual([POST_A, POST_D]);
    const channels = (cursor as TeamsCursor).channels as ChannelsCursor;
    expect(channels.marks[`${TL}/${GENERAL}`]).toEqual({
      seen: Date.parse('2026-10-01T13:00:00.000Z'),
      checked: NOW,
      active: Date.parse('2026-10-01T13:00:00.000Z'),
    });
    expect(channels.marks['team-ops/19:general-ops@thread.tacv2']).toEqual({
      seen: NOW - 14 * 24 * HOUR,
      checked: NOW,
      active: null,
    });
  });

  it('keeps each thread as one Item: subject, post, replies oldest first, mentions and links', async () => {
    await afterFirstSync();
    const item = held.get(POST_A);
    expect(item).toMatchObject({
      kind: 'channel-post',
      title: 'Release 4.2',
      people: ['teams:u-priya', 'teams:u-omar'],
    });
    const detail = postOf(POST_A);
    expect(detail).toMatchObject({
      team: { id: TL, name: 'Titanlink' },
      channel: { id: GENERAL, name: 'General' },
      subject: 'Release 4.2',
      mentionsMe: true,
      lastActivityAt: Date.parse('2026-10-01T13:00:00.000Z'),
    });
    expect(detail?.webUrl).toMatch(/^https:\/\/teams\.microsoft\.com\/l\/message\//);
    expect(detail?.replies.map((reply) => reply.text)).toEqual([
      'Looks good to me.',
      '@Releases heads up, and @Sam Rivera can you check the notes?',
    ]);
    const mention = detail?.replies[1];
    expect(mention?.mentions).toEqual([
      { userId: null, name: 'Releases' },
      { userId: ME, name: 'Sam Rivera' },
    ]);
    expect(mention?.conversationMentions).toEqual([{ kind: 'channel', id: RELEASES, name: 'Releases' }]);
  });

  it('keeps nothing of hostile markup in a post: no script, style, frame, image or javascript link', async () => {
    await afterFirstSync();
    const text = postOf(POST_A)?.post.text ?? '';
    expect(text).toBe('Release 4.2 is out.\n\n[image]\n\nnotes and the notes (https://example.test/notes)');
    expect(text).not.toMatch(/alert|javascript|evil|<|onerror/);
  });

  it('pages replies beyond what the thread’s expansion held', async () => {
    await afterFirstSync();
    expect(postOf(POST_D)?.replies.map((reply) => reply.text)).toEqual(['First', 'Second', 'Third']);
    expect(held.get(POST_D)?.title).toBe('Deploy window is Friday');
  });
});

describe('later syncs of Channel posts', () => {
  it('bring new posts, new replies and deletions, reading only the channels due', async () => {
    const cursor = await afterFirstSync();
    const recorded = replay(later as Exchange[]);
    const { run, pages } = await sync(recorded.fetch, { cursor, mode: 'light', start: NOW + HOUR });
    await run;
    expect(recorded.remaining()).toBe(0);
    // No listing on a light check within the day; the quiet Ops channel isn't due for 6 hours.
    expect(sent.map((each) => each.path)).not.toContain('/me/joinedTeams?$select=id,displayName');
    expect(sent.some((each) => each.path.includes(OPS_GENERAL))).toBe(false);

    expect(postOf(POST_A)?.replies.map((reply) => reply.id)).toEqual([
      '1790850000001',
      '1790850000002',
      '1790990000003',
    ]);
    expect(held.get(POST_E)?.title).toBe('Who is on call this weekend?');
    // The deleted post becomes a tombstone.
    expect(pages.flatMap((page) => page.deleted)).toEqual([POST_D]);
    expect(held.has(POST_D)).toBe(false);
  });

  it('paces each channel to one request a second, and spaces all channel requests', async () => {
    await afterFirstSync();
    // (sent was cleared; run the first sync again to look at its timings.)
    held = new Map();
    const { run } = await sync(replay(firstSync as Exchange[]).fetch);
    await run;
    const channelRequests = sent.slice(1);
    for (let i = 1; i < channelRequests.length; i++) {
      const gap = (channelRequests[i]?.at ?? 0) - (channelRequests[i - 1]?.at ?? 0);
      expect(gap).toBeGreaterThanOrEqual(CHANNEL_GAP_MS);
    }
    const releases = sent.filter((each) => each.path.includes(RELEASES));
    expect(releases).toHaveLength(2);
    expect((releases[1]?.at ?? 0) - (releases[0]?.at ?? 0)).toBeGreaterThanOrEqual(PER_CHAT_GAP_MS);
  });
});

describe('choosing channels', () => {
  it('skips an excluded channel, and hands back its posts as deleted', async () => {
    await afterFirstSync();
    const exchanges = (firstSync as Exchange[]).filter(
      (each) => !each.request.path.includes(RELEASES) || each.request.path.includes('$select'),
    );
    const { run, pages } = await sync(replay(exchanges).fetch, {
      channelPosts: { excluded: [{ teamId: TL, channelId: RELEASES }] },
    });
    const { cursor } = await run;
    expect(sent.some((each) => each.path.includes(`${RELEASES}/messages`))).toBe(false);
    expect(pages.flatMap((page) => page.deleted)).toEqual([POST_D]);
    expect(Object.keys((cursor as TeamsCursor).channels?.marks ?? {})).not.toContain(`${TL}/${RELEASES}`);
  });

  it('skips a whole excluded team', async () => {
    const exchanges = (firstSync as Exchange[]).filter((each) => !each.request.path.includes('general-ops@'));
    const { run } = await sync(replay(exchanges).fetch, {
      channelPosts: { excluded: [{ teamId: 'team-ops', channelId: null }] },
    });
    await run;
    expect(sent.some((each) => each.path.includes('general-ops'))).toBe(false);
  });
});

describe('when Channel posts are off or refused', () => {
  it('reads no channel, and hands back every post still held as deleted', async () => {
    const cursor = await afterFirstSync();
    const chatsOnly = replay([(firstSync as Exchange[])[0] as Exchange]);
    const { run, pages } = await sync(chatsOnly.fetch, { cursor, channelPosts: null });
    const result = await run;
    expect(sent.map((each) => each.path)).toEqual(['/me/chats?$expand=lastMessagePreview&$top=50']);
    expect(pages.flatMap((page) => page.deleted).sort()).toEqual([POST_A, POST_D]);
    expect((result.cursor as TeamsCursor).channels).toBeUndefined();
  });

  it('says so when Microsoft refuses for want of permission, and Chats still sync', async () => {
    const recorded = replay(refused as Exchange[]);
    const { run, refusals } = await sync(recorded.fetch);
    const result = await run;
    expect(recorded.remaining()).toBe(0);
    expect(refusals()).toBe(1);
    expect(held.size).toBe(0);
    expect((result.cursor as TeamsCursor).chats).toEqual({});
  });

  it('stops at a rate limit, keeping the Chats and the channels already read', async () => {
    const exchanges = (firstSync as Exchange[]).slice(0, 5);
    exchanges.push({
      request: { path: `/teams/${TL}/channels/${RELEASES}/messages?$top=20&$expand=replies` },
      response: { status: 429, headers: { 'retry-after': '30' }, body: null },
    });
    const { run, checkpoints } = await sync(replay(exchanges).fetch);
    await expect(run).rejects.toBeInstanceOf(RateLimited);
    const last = checkpoints.at(-1) as TeamsCursor;
    expect(last.chats).toEqual({});
    expect(Object.keys(last.channels?.marks ?? {})).toEqual([`${TL}/${GENERAL}`]);
    expect(held.has(POST_A)).toBe(true);
  });
});

describe('replying to a Channel post', () => {
  const REPLIES = `/teams/${TL}/channels/${GENERAL}/messages/1790840000000/replies`;
  const reply = { clientId: 'c-1', text: 'On it <b>now</b>', createdAt: NOW };
  const posted = {
    id: '1791000000000',
    replyToId: '1790840000000',
    messageType: 'message',
    createdDateTime: '2026-10-03T12:00:01.000Z',
    lastModifiedDateTime: '2026-10-03T12:00:01.000Z',
    deletedDateTime: null,
    from: { user: { id: ME, displayName: 'Sam Rivera' } },
    body: { contentType: 'html', content: 'On it &lt;b&gt;now&lt;/b&gt;' },
    attachments: [],
    mentions: [],
    reactions: [],
  };

  async function write(exchanges: Exchange[], attemptedAt?: number) {
    await afterFirstSync();
    clock = NOW;
    const source = createTeamsSource({
      graphUrl: () => GRAPH,
      fetch: replay(exchanges).fetch,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    return source.write?.({
      account: 'teams:fake-tenant:u-sam',
      externalId: POST_A,
      changes: [
        {
          field: 'reply:c-1',
          value: reply,
          synced: null,
          madeAt: NOW,
          ...(attemptedAt ? { attemptedAt } : {}),
        },
      ],
      me: ME,
      stored: (ids) =>
        ids.flatMap((id): StoredItem[] => {
          const item = held.get(id);
          return item
            ? [{ externalId: id, title: item.title, people: [], status: 'open', detail: item.detail ?? null }]
            : [];
        }),
      accessToken: async () => token,
      signal: new AbortController().signal,
    });
  }

  it('posts it to the post’s replies as escaped HTML, and hands back the thread with it', async () => {
    const result = await write([
      { request: { path: REPLIES }, response: { status: 201, headers: {}, body: posted } },
    ]);
    expect(sent).toMatchObject([
      {
        path: REPLIES,
        method: 'POST',
        body: { body: { contentType: 'html', content: 'On it &lt;b&gt;now&lt;/b&gt;' } },
      },
    ]);
    const detail = result?.item?.detail as ChannelPostDetail;
    expect(detail.replies.at(-1)).toMatchObject({ id: '1791000000000', text: 'On it <b>now</b>' });
    expect(WRITE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('doesn’t post twice when an earlier attempt got through', async () => {
    const result = await write(
      [
        {
          request: { path: `${REPLIES}?$top=50` },
          response: { status: 200, headers: {}, body: { value: [posted] } },
        },
      ],
      NOW,
    );
    expect(sent.map((each) => each.method)).toEqual(['GET']);
    expect((result?.item?.detail as ChannelPostDetail | undefined)?.replies.map((each) => each.id)).toContain(
      '1791000000000',
    );
  });
});
