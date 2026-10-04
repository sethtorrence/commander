import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, ChatMessage, QueuedLine, SourceItem } from '@commander/domain';
import { defaultModelSettings, SUMMARISE_CHAT } from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chat, LEE, message, OMAR, SAM, TEAMS } from '../agent/fixtures/teams-chats';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { setUpUpdates, type Updates } from '.';
import { PUT_UPDATES_TOGETHER } from './compose';

// Busy Teams Chats in the Update (#109), and asking for an Update checking Teams first, through the
// Core's interface on a real Item store, gate and model client. Only the model is fake: it answers
// "Summarise Chat" from a recorded reply and leaves the Update's own wording alone.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const user: ActionContext = { by: { kind: 'user' } };
const SUMMARY = 'They settled on shipping Friday, and Omar wants your sign-off.';

let dir: string;
let clock: number;
let store: ItemStore;
let gate: Gate;
let updates: Updates;
let calls: ProviderRequest[];
let summaries: (string | Error)[];
let refreshes: number;
let refresh: () => Promise<unknown>;

const jobOf = (request: ProviderRequest) =>
  /Teams chat/.test(request.messages[0]?.content ?? '') ? SUMMARISE_CHAT : PUT_UPDATES_TOGETHER;

const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    if (jobOf(request) === SUMMARISE_CHAT) {
      const next = summaries.shift() ?? SUMMARY;
      if (next instanceof Error) throw next;
      return {
        text: JSON.stringify({ summary: next }),
        usage: { inputTokens: 3000, cachedTokens: 0, outputTokens: 80 },
      };
    }
    return { text: '{"lines":[]}', usage: { inputTokens: 500, cachedTokens: 0, outputTokens: 10 } };
  },
  stream: () => Promise.reject(new Error('not used')),
};

function setUp(refreshWaitMs?: number) {
  updates?.stop();
  updates = setUpUpdates({
    itemStore: store,
    gate,
    client: createModelClient({
      settings: () => store.models.settings(),
      providers: { zai: provider },
      ledger: store.models,
      now: () => clock,
    }),
    now: () => clock,
    me: (account) => (account === TEAMS ? SAM.userId : null),
    refreshTeams: () => {
      refreshes += 1;
      return refresh();
    },
    ...(refreshWaitMs !== undefined && { refreshWaitMs }),
    log: () => {},
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-updates-teams-'));
  clock = new Date(2026, 9, 1, 11, 40).getTime();
  calls = [];
  summaries = [];
  refreshes = 0;
  refresh = () => Promise.resolve();
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  gate = openGate({ itemStore: store, onChange: () => updates?.sweep() });
  setUp();
});

afterEach(() => {
  updates.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// `count` messages from others (Omar and Lee in turn) in the last few hours, and one of the User's.
function busy(count: number, start = clock - 4 * HOUR): ChatMessage[] {
  return [
    ...Array.from({ length: count }, (_, i) =>
      message(
        i % 2 ? LEE : OMAR,
        start + i * MINUTE,
        i === count - 1 ? 'Sam, can you sign off?' : `Point ${i + 1}`,
      ),
    ),
    message(SAM, start + count * MINUTE, 'Reading along.'),
  ];
}

function sync(...items: SourceItem[]) {
  store.saveFromSource({ source: 'teams', account: TEAMS, me: SAM.userId, items, deleted: [] });
  updates.sweep();
}

const chatLines = () =>
  updates.queue
    .list()
    .filter(
      (line): line is QueuedLine & { about: { kind: 'chat-summary' } } => line.about.kind === 'chat-summary',
    );
const idOf = (title: string) => store.query({ kinds: ['chat'] }).find((item) => item.title === title)?.id;

describe('busy Chats in the Update', () => {
  it('a busy unmuted Chat gets one merged For your information line; quiet and muted ones don’t', () => {
    sync(
      chat('19:titanlink@thread.v2', 'Titanlink eng', 'group', [OMAR, LEE], busy(24)),
      chat('19:social@thread.v2', 'Social', 'group', [LEE], busy(5)),
      chat('19:alerts@thread.v2', 'Noisy alerts', 'group', [OMAR], busy(40)),
    );
    store.chatSettings.change({ account: TEAMS, chatId: '19:alerts@thread.v2', change: 'mute' }, user);
    updates.sweep();
    expect(chatLines()).toEqual([
      expect.objectContaining({
        group: 'fyi',
        section: 'teams',
        mergeKey: `chat-summary:${idOf('Titanlink eng')}`,
        itemIds: [idOf('Titanlink eng')],
        about: { kind: 'chat-summary', itemId: idOf('Titanlink eng'), count: 24, since: clock - 24 * HOUR },
      }),
    ]);

    // More messages: still one line, with the newer count.
    clock += 10 * MINUTE;
    sync(chat('19:titanlink@thread.v2', 'Titanlink eng', 'group', [OMAR, LEE], busy(30)));
    expect(chatLines()).toHaveLength(1);
    expect(chatLines()[0]?.about.count).toBe(30);

    // Muted later: the line goes.
    store.chatSettings.change({ account: TEAMS, chatId: '19:titanlink@thread.v2', change: 'mute' }, user);
    updates.sweep();
    expect(chatLines()).toEqual([]);
  });

  it('is summarised when the Update is put together: one or two sentences, opening the Chat', async () => {
    sync(chat('19:titanlink@thread.v2', 'Titanlink eng', 'group', [OMAR, LEE], busy(46)));
    // Nothing is summarised ahead of time.
    expect(calls).toHaveLength(0);

    const update = await updates.give();
    const line = update?.lines.find((each) => each.kind === 'chat-summary');
    expect(line).toMatchObject({
      group: 'fyi',
      section: 'teams',
      text: `Titanlink eng: 46 messages. ${SUMMARY}`,
      itemIds: [idOf('Titanlink eng')],
    });
    expect(update?.voice).toBe('ares');
    // One Deep call at high thinking under Summarise Chat, the Chat alone in an outside block with
    // the messages since the last Update; the line itself isn't sent to be reworded.
    const summarised = calls.filter((call) => jobOf(call) === SUMMARISE_CHAT);
    expect(summarised).toHaveLength(1);
    expect(summarised[0]).toMatchObject({ reasoningEffort: 'high' });
    expect(summarised[0]?.messages.at(-1)?.content).toMatch(
      /label="Teams group chat: Titanlink eng" source="outside">/,
    );
    expect(summarised[0]?.messages.at(-1)?.content).toContain('· the User: Reading along.');
    expect(store.models.usageSummary().byJob.map((row) => row.job)).toContain(SUMMARISE_CHAT);
    expect(calls.filter((call) => jobOf(call) === PUT_UPDATES_TOGETHER)).toHaveLength(0);
    // Its sources are the Chat's messages, for AresText's links.
    expect(line?.sources.length).toBeGreaterThan(1);
  });

  it('keeps a plain sentence when Ares can’t summarise it', async () => {
    sync(chat('19:titanlink@thread.v2', 'Titanlink eng', 'group', [OMAR, LEE], busy(22)));
    summaries.push(new Error('Z.ai is down'), new Error('Z.ai is down'));
    const update = await updates.give();
    expect(update?.lines.find((each) => each.kind === 'chat-summary')?.text).toBe(
      'Titanlink eng: 22 messages since your last Update.',
    );
  });

  it('counts from the last Update, and follows the threshold in Settings → Ares', async () => {
    sync(chat('19:titanlink@thread.v2', 'Titanlink eng', 'group', [OMAR, LEE], busy(25)));
    const first = await updates.give();
    const line = first?.lines.find((each) => each.kind === 'chat-summary');
    updates.act(line?.queuedId as number, 'done');

    // A few more since: not busy again yet.
    clock += HOUR;
    sync(
      chat(
        '19:titanlink@thread.v2',
        'Titanlink eng',
        'group',
        [OMAR, LEE],
        [...busy(25), ...busy(6, clock - 30 * MINUTE)],
      ),
    );
    expect(chatLines()).toEqual([]);

    // Five is enough, says the User.
    store.models.saveSettings({ ...defaultModelSettings, busyChatMessages: 5 });
    updates.sweep();
    expect(chatLines().map((each) => each.about.count)).toEqual([6]);
  });
});

describe('asking for an Update checks Teams first', () => {
  it('runs a light sync of every Teams Account before putting it together', async () => {
    let synced = false;
    refresh = async () => {
      sync(chat('19:titanlink@thread.v2', 'Titanlink eng', 'group', [OMAR, LEE], busy(21)));
      synced = true;
    };
    const update = (await updates.skills.run('update', undefined)) as Awaited<ReturnType<Updates['give']>>;
    expect(refreshes).toBe(1);
    expect(synced).toBe(true);
    expect(update?.lines.map((each) => each.kind)).toContain('chat-summary');
  });

  it('goes on with what’s there after 5 seconds if Teams is slow', async () => {
    setUp(50);
    sync(chat('19:titanlink@thread.v2', 'Titanlink eng', 'group', [OMAR, LEE], busy(21)));
    refresh = () => new Promise(() => {});
    const started = Date.now();
    const update = (await updates.skills.run('update', undefined)) as Awaited<ReturnType<Updates['give']>>;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(update?.lines.map((each) => each.kind)).toEqual(['chat-summary']);
  });
});

describe('Summarise on request', () => {
  it('answers the window’s request with the summary of one range', async () => {
    sync(chat('19:titanlink@thread.v2', 'Titanlink eng', 'group', [OMAR, LEE], busy(3, clock - HOUR)));
    summaries.push('Omar and Lee went over three points, and Omar wants your sign-off.');
    const summary = await updates.summarise(idOf('Titanlink eng') as string, 'today');
    expect(summary).toMatchObject({ range: 'today', count: 4 });
    expect(summary.text).toBeTypeOf('string');
    expect(calls).toHaveLength(1);
  });
});
