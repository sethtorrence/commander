import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ActionContext,
  ChannelMessage,
  ChannelPostDetail,
  ChannelReply,
  Item,
  SourceItem,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Channel posts in the Item store (#111): each thread a `channel-post` Item with its own detail table;
// the seen mark Commander's own (logged, kept through syncs, never queued for Teams); a reply queued
// for Teams like a Chat's and unrecallable once there; and teams and channels the User excludes,
// whose posts go.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const TEAMS = 'teams:tenant-1:u-sam';
const TL = 'team-tl';
const GENERAL = '19:general@thread.tacv2';
const RELEASES = '19:releases@thread.tacv2';
const user: ActionContext = { by: { kind: 'user' } };
const T = Date.UTC(2026, 9, 3, 9);
const MIN = 60_000;

let dir: string;
let store: ItemStore;
let clock: number;

beforeEach(() => {
  clock = T;
  dir = mkdtempSync(join(tmpdir(), 'commander-channel-posts-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const message = (id: string, at: number): ChannelMessage => ({
  id,
  from: { userId: 'u-priya', name: 'Priya Patel' },
  event: null,
  createdAt: at,
  modifiedAt: at,
  deleted: false,
  text: `Message ${id}`,
  mentions: [],
  reactions: [],
  attachments: [],
  replyTo: null,
});

function post(
  id: string,
  channel = GENERAL,
  replies: ChannelMessage[] = [message(`${id}-r1`, T - MIN)],
): SourceItem {
  const detail: ChannelPostDetail = {
    kind: 'channel-post',
    team: { id: TL, name: 'Titanlink' },
    channel: { id: channel, name: channel === GENERAL ? 'General' : 'releases' },
    subject: null,
    post: message(id, T - 10 * MIN),
    replies,
    webUrl: null,
    mentionsMe: false,
    lastActivityAt: replies.at(-1)?.createdAt ?? T - 10 * MIN,
  };
  return { externalId: `${TL}/${channel}/${id}`, kind: 'channel-post', title: `Post ${id}`, detail };
}

function saved(...items: SourceItem[]): Item[] {
  store.saveFromSource({ source: 'teams', account: TEAMS, items, deleted: [] });
  return store.query({ kinds: ['channel-post'] });
}

const detailOf = (itemId: string) => store.get(itemId)?.item.detail as ChannelPostDetail;
const reply = (clientId: string): ChannelReply => ({ clientId, text: 'On it.', createdAt: clock });

describe('a Channel post in the Item store', () => {
  it('keeps the thread, and logs a sync’s new replies in summary', () => {
    const [found] = saved(post('p1'));
    if (!found) throw new Error('No post saved');
    expect(detailOf(found.id)).toMatchObject({ team: { id: TL }, replies: [{ id: 'p1-r1' }] });

    saved(post('p1', GENERAL, [message('p1-r1', T - MIN), message('p1-r2', T)]));
    const [latest] = store.activity({ itemId: found.id });
    expect(latest?.summaries).toEqual([
      { field: 'replies', count: 2, added: 1, changed: 0, removed: 0, latest: { id: 'p1-r2', at: T } },
    ]);
  });

  it('keeps the seen mark through syncs, and never queues it for Teams', () => {
    const [found] = saved(post('p1'));
    if (!found) throw new Error('No post saved');
    store.record({ type: 'edit-fields', itemId: found.id, fields: { seen: T } }, user);
    saved(post('p1', GENERAL, [message('p1-r1', T - MIN), message('p1-r2', T + MIN)]));

    expect(detailOf(found.id).seenAt).toBe(T);
    expect(detailOf(found.id).replies).toHaveLength(2);
    expect(store.outgoing.forItem(found.id)).toEqual([]);
  });

  it('queues a reply for Teams, which only the User may send and can’t recall once sent', () => {
    const [found] = saved(post('p1'));
    if (!found) throw new Error('No post saved');
    const fields = { 'reply:c1': reply('c1') };
    expect(() =>
      store.record({ type: 'edit-fields', itemId: found.id, fields }, { by: { kind: 'ares' } }),
    ).toThrow(/Only you can send/);
    const entry = store.record({ type: 'edit-fields', itemId: found.id, fields }, user);
    expect(detailOf(found.id).pending).toEqual([reply('c1')]);
    expect(store.outgoing.forItem(found.id).map((row) => row.field)).toEqual(['reply:c1']);

    store.outgoing.settle(store.outgoing.forItem(found.id).map((row) => row.id));
    expect(() => store.record({ type: 'undo', entryId: entry.id }, user)).toThrow(/can’t be recalled/);
  });
});

describe('excluding teams and channels', () => {
  beforeEach(() => {
    store.syncState.saveCatalog(
      TEAMS,
      'teams',
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
        ],
      },
      T,
    );
  });

  it('lists each Account’s teams and channels as last listed, every one included', () => {
    expect(store.channelSettings.choices()).toEqual([
      {
        account: TEAMS,
        listedAt: T,
        teams: [
          {
            id: TL,
            name: 'Titanlink',
            excluded: false,
            channels: [
              { id: GENERAL, name: 'General', excluded: false },
              { id: RELEASES, name: 'releases', excluded: false },
            ],
          },
        ],
      },
    ]);
  });

  it('deletes the posts of an excluded channel as the User, and tells sync to skip it until included', () => {
    const [general, releases] = saved(post('p1'), post('p2', RELEASES)).sort((a, b) =>
      a.title.localeCompare(b.title),
    );
    const choices = store.channelSettings.change(
      { account: TEAMS, teamId: TL, channelId: RELEASES, change: 'exclude' },
      user,
    );
    expect(choices.teams[0]?.channels.map((each) => each.excluded)).toEqual([false, true]);
    expect(store.channelSettings.excluded(TEAMS)).toEqual([{ teamId: TL, channelId: RELEASES }]);
    expect(store.get(releases?.id ?? '')?.item.deletedAt).toBe(T);
    expect(store.get(general?.id ?? '')?.item.deletedAt).toBeNull();
    expect(store.activity({ itemId: releases?.id })[0]).toMatchObject({
      action: 'delete',
      by: { kind: 'user' },
      why: 'Excluded the channel from Commander',
    });

    store.channelSettings.change(
      { account: TEAMS, teamId: TL, channelId: RELEASES, change: 'include' },
      user,
    );
    expect(store.channelSettings.excluded(TEAMS)).toEqual([]);
  });

  it('excludes a whole team, every channel in it', () => {
    saved(post('p1'), post('p2', RELEASES));
    const choices = store.channelSettings.change(
      { account: TEAMS, teamId: TL, channelId: null, change: 'exclude' },
      user,
    );
    expect(choices.teams[0]).toMatchObject({
      excluded: true,
      channels: [{ excluded: true }, { excluded: true }],
    });
    expect(store.query({ kinds: ['channel-post'] })).toEqual([]);
  });
});
