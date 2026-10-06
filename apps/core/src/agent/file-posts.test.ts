import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ActionContext,
  ChannelMessage,
  ChannelPostDetail,
  Project,
  SourceItem,
} from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { fileIntoProjectsJob } from './file-into-projects';
import { createJobRunner, type JobRunner } from './runner';

// Channel posts (#111) in Rules and Ares's "File into Projects": "team is Titanlink → TL" files every
// post in that team, and Ares considers the posts no Rule files, one data block each.

const user: ActionContext = { by: { kind: 'user' } };
const TEAMS = 'teams:tenant-1:u-sam';
const T = Date.UTC(2026, 9, 3, 9);

let dir: string;
let store: ItemStore;
let runner: JobRunner;
let calls: ProviderRequest[];
let tl: Project;
let tx: Project;

const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    const content = request.messages.at(-1)?.content ?? '';
    const [, ref] = /label="(I\d+) · Teams channel post"/.exec(content) ?? [];
    const filings = ref
      ? [{ itemId: ref, projectCode: 'TX', confidence: 0.8, reason: 'Ops is Tactics work' }]
      : [];
    return {
      text: JSON.stringify({ filings, steering: [] }),
      usage: { inputTokens: 500, cachedTokens: 0, outputTokens: 30 },
    };
  },
  stream: () => Promise.reject(new Error('not used')),
};

const message = (id: string, text: string): ChannelMessage => ({
  id,
  from: { userId: 'u-priya', name: 'Priya Patel' },
  event: null,
  createdAt: T,
  modifiedAt: T,
  deleted: false,
  text,
  mentions: [],
  reactions: [],
  attachments: [],
  replyTo: null,
});

function post(team: { id: string; name: string }, channel: string, id: string, text: string): SourceItem {
  const detail: ChannelPostDetail = {
    kind: 'channel-post',
    team,
    channel: { id: `19:${channel}@thread.tacv2`, name: channel },
    subject: null,
    post: message(id, text),
    replies: [message(`${id}-r`, 'Agreed')],
    webUrl: null,
    mentionsMe: false,
    lastActivityAt: T,
  };
  return {
    externalId: `${team.id}/19:${channel}@thread.tacv2/${id}`,
    kind: 'channel-post',
    title: text,
    detail,
  };
}

function project(name: string, code: string): Project {
  return store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project as Project;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-file-posts-'));
  calls = [];
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => T,
  });
  tl = project('Titanlink', 'TL');
  tx = project('Tactics', 'TX');
  store.changeRule({
    type: 'create',
    rule: {
      target: { kind: 'project', projectId: tl.id },
      when: { join: 'and', terms: [{ field: 'teams.team', op: 'is', value: 'team-tl', label: 'Titanlink' }] },
    },
  });
  runner = createJobRunner({
    jobs: [fileIntoProjectsJob(store)],
    client: createModelClient({
      settings: () => store.models.settings(),
      providers: { zai: provider },
      ledger: store.models,
      now: () => T,
    }),
    gate: openGate({ itemStore: store }),
    store: store.agent,
    now: () => T,
    log: () => {},
  });
});

afterEach(() => {
  runner.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('filing Channel posts', () => {
  it('files every post in a team by its Rule, and Ares considers the rest, each in its own block', async () => {
    store.saveFromSource({
      source: 'teams',
      account: TEAMS,
      items: [
        post({ id: 'team-tl', name: 'Titanlink' }, 'releases', 'p1', 'Release 4.2 is out'),
        post({ id: 'team-ops', name: 'Ops' }, 'on-call', 'p2', 'Pager rota for next week'),
      ],
    });
    const byTitle = Object.fromEntries(
      store.query({ kinds: ['channel-post'] }).map((item) => [item.title, item]),
    );
    expect(byTitle['Release 4.2 is out']?.filing).toEqual({ projectId: tl.id, filedBy: 'rule' });

    runner.trigger({ kind: 'items-arrived', itemIds: [] });
    await runner.settled();

    const prompts = calls.map((call) => call.messages.at(-1)?.content ?? '');
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0] ?? '';
    expect(prompt).toMatch(/label="I1 · Teams channel post" source="outside">/);
    expect(prompt).toContain('Team: Ops');
    expect(prompt).toContain('Channel: on-call');
    expect(prompt).toContain('Pager rota for next week');
    expect(prompt).not.toContain('Release 4.2');
    // Ares's suggestion waits for the User (Organise at Ask by default) or files it.
    const pager = store.get(byTitle['Pager rota for next week']?.id ?? '')?.item;
    expect(pager?.filingSuggestion?.projectId ?? pager?.filing?.projectId).toBe(tx.id);
    void user;
  });
});
