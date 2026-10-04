import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionContext,
  jobDisplayName,
  type SourceItem,
  SUGGEST_TODOS_FROM_TEAMS,
} from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { chat, HOUR, MINUTE, message, OMAR, SAM, TEAMS } from './fixtures/teams-chats';
import { chatIn, FOOLED_TODO_REPLY, fillIn, TODO_REPLIES, workChats } from './fixtures/teams-work';
import { createJobRunner, type JobRunner } from './runner';
import { suggestChatTodosJob } from './suggest-chat-todos';
import { SUGGEST_TODOS } from './suggest-todos';

// "Suggest Todos from Teams" (#110) through the runner, on fixture Chats saved as Teams sync saves
// them in a real Item store, with the gate deciding and recorded replies from a fake provider
// (GLM-5.3-Flash in JSON mode), one Chat per call. Thursday 1 October 2026, 11:40.

const NOW = new Date(2026, 9, 1, 11, 40).getTime();
const user: ActionContext = { by: { kind: 'user' } };

let dir: string;
let clock: number;
let store: ItemStore;
let gate: Gate;
let runner: JobRunner;
let calls: ProviderRequest[];
// A recorded reply for a Chat, by its name; the fixture's own unless a test says otherwise.
let replies: Record<string, string | ((prompt: string) => unknown)>;
let logged: string[];

const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    const prompt = request.messages.at(-1)?.content ?? '';
    const next = replies[chatIn(prompt) ?? ''] ?? '{"todos":[]}';
    const reply = typeof next === 'string' ? fillIn(next, prompt) : next(prompt);
    return { text: JSON.stringify(reply), usage: { inputTokens: 700, cachedTokens: 0, outputTokens: 60 } };
  },
  stream: () => Promise.reject(new Error('not used')),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-chat-todos-'));
  clock = NOW;
  calls = [];
  replies = { ...TODO_REPLIES };
  logged = [];
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  gate = openGate({ itemStore: store });
  const client = createModelClient({
    settings: () => store.models.settings(),
    providers: { zai: provider },
    ledger: store.models,
    now: () => clock,
  });
  runner = createJobRunner({
    jobs: [
      suggestChatTodosJob(store, {
        now: () => clock,
        me: (account) => (account === TEAMS ? SAM.userId : null),
      }),
    ],
    client,
    gate,
    store: store.agent,
    injectionWarnings: store.injectionWarnings,
    now: () => clock,
    log: (line) => logged.push(line),
  });
});

afterEach(() => {
  runner.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function sync(...items: SourceItem[]) {
  store.saveFromSource({ source: 'teams', account: TEAMS, me: SAM.userId, items, deleted: [] });
}

async function afterTeamsSync() {
  runner.trigger({ kind: 'source-sync', source: 'teams', account: TEAMS });
  await runner.settled();
}

const idOf = (title: string) =>
  store.query({ kinds: ['chat'] }).find((item) => item.title === title)?.id as string;
const messageId = (title: string, text: string) => {
  const detail = store.get(idOf(title))?.item.detail;
  return detail?.kind === 'chat' ? detail.messages.find((each) => each.text.includes(text))?.id : undefined;
};
const todos = () => store.query({ kinds: ['todo'] });
const pending = () => store.autonomy.proposals({ statuses: ['pending'] });
const prompts = () => calls.map((call) => call.messages.at(-1)?.content ?? '');
const promptFor = (title: string) => prompts().find((prompt) => chatIn(prompt) === title) ?? '';

// The fixture, with the alerts Chat muted and Omar's Chat filed under TL by the User.
function syncFixture() {
  const chats = workChats(NOW);
  sync(chats.omar, chats.titanlink, chats.social, chats.alerts, chats.mallory);
  store.chatSettings.change({ account: TEAMS, chatId: '19:alerts@thread.v2', change: 'mute' }, user);
  const tl = store.changeProject({
    type: 'create',
    project: { name: 'Titanlink', code: 'TL', accent: 'blue' },
  }).project?.id as string;
  store.record(
    { type: 'update', itemId: idOf('Omar Haddad'), changes: { filing: { projectId: tl, filedBy: 'user' } } },
    user,
  );
  return { chats, tl };
}

describe('Todos from Chats', () => {
  it('turns a request to the User and the User’s own promise into Ares Todos, linked to the Chat at the message', async () => {
    const { tl } = syncFixture();
    await afterTeamsSync();

    // At Auto when sure (the default), the confident ones are added.
    const added = todos().sort((a, b) => a.title.localeCompare(b.title));
    expect(added.map((todo) => todo.title)).toEqual(['Send Omar the TL budget', 'Send the release notes']);
    const [budget, notes] = added;
    expect(budget?.detail).toEqual({
      kind: 'todo',
      origin: 'ares',
      dueOn: '2026-10-02',
      backedBy: null,
      fromMessage: { itemId: idOf('Omar Haddad'), messageId: messageId('Omar Haddad', 'TL budget') },
    });
    // The Chat's Project, as inherited; a Chat with none leaves it Unfiled.
    expect(budget?.filing).toEqual({ projectId: tl, filedBy: 'inherited' });
    expect(notes?.filing).toBeNull();
    // A made-from Link to the Chat.
    expect(store.get(budget?.id as string)?.links).toEqual([
      expect.objectContaining({
        type: 'made-from',
        to: expect.objectContaining({ id: idOf('Omar Haddad') }),
      }),
    ]);
    // Recorded as Ares's, from Teams, under Suggest Todos in the Teams Section.
    const [done] = store.autonomy.proposals({ itemId: idOf('Omar Haddad') });
    expect(done).toMatchObject({
      action: SUGGEST_TODOS,
      actionKind: 'organise',
      section: 'teams',
      status: 'done',
    });
    expect(done?.reason).toBe('Omar Haddad asked in Teams: “Can you send me the TL budget by Friday?”');
    const [notesDone] = store.autonomy.proposals({ itemId: idOf('Titanlink eng') });
    expect(notesDone?.reason).toBe('You said in Teams: “I’ll send the release notes tomorrow.”');
    expect(store.activity({ itemId: budget?.id as string })[0]?.by).toEqual({ kind: 'ares' });
  });

  it('sends each unmuted Chat with new messages in a call of its own, as outside material; chatter makes nothing', async () => {
    syncFixture();
    await afterTeamsSync();

    // One Quick call at low thinking per Chat, under the job's name on the Usage page; never the muted one.
    expect(prompts().map(chatIn).sort()).toEqual(['Mallory', 'Omar Haddad', 'Social', 'Titanlink eng']);
    expect(calls.every((call) => call.reasoningEffort === 'low')).toBe(true);
    expect(store.models.usageSummary().byJob.map((row) => row.job)).toEqual([SUGGEST_TODOS_FROM_TEAMS]);
    expect(jobDisplayName(SUGGEST_TODOS_FROM_TEAMS)).toBe('Suggest Todos from Teams');
    expect(prompts().join('\n')).not.toContain('restart the runner');
    // Each Chat alone in an outside data block, its messages marked by who they are to and from.
    for (const prompt of prompts()) expect(prompt.match(/<data-[0-9a-f]+ ref="U\d"/g)).toHaveLength(1);
    expect(promptFor('Omar Haddad')).toContain(
      'label="C1 · Teams one-to-one chat: Omar Haddad" source="outside"',
    );
    expect(promptFor('Omar Haddad')).toMatch(
      /┆ M2 · NEW · 2026-10-01 11:20 · Omar Haddad, to the User: Can you send me/,
    );
    expect(promptFor('Titanlink eng')).toMatch(/┆ M2 · NEW · 2026-10-01 10:10 · Omar Haddad: Who is writing/);
    expect(promptFor('Titanlink eng')).toMatch(
      /┆ M3 · NEW · 2026-10-01 10:20 · the User: I’ll send the release notes/,
    );
    // Social's chatter: nothing proposed.
    expect(store.autonomy.proposals({ itemId: idOf('Social') })).toEqual([]);
    // Registered with the gate under Suggest Todos, as Organise.
    expect(gate.actions()).toContainEqual(
      expect.objectContaining({ action: SUGGEST_TODOS, actionKind: 'organise' }),
    );
  });

  it('looks only at new messages: nothing new, no call; a new one, with the earlier ones as context', async () => {
    const { chats } = syncFixture();
    await afterTeamsSync();
    const first = calls.length;

    clock = NOW + 10 * MINUTE;
    await afterTeamsSync();
    expect(calls).toHaveLength(first);

    const before = chats.omar.detail?.kind === 'chat' ? chats.omar.detail.messages : [];
    sync(
      chat(
        '19:omar_sam@unq.gbl.spaces',
        'Omar Haddad',
        'one-on-one',
        [OMAR],
        [...before, message(OMAR, NOW + 5 * MINUTE, 'Thanks!')],
      ),
    );
    replies['Omar Haddad'] = '{"todos":[]}';
    await afterTeamsSync();
    expect(calls).toHaveLength(first + 1);
    expect(chatIn(prompts().at(-1) ?? '')).toBe('Omar Haddad');
    expect(prompts().at(-1)).toMatch(/┆ M2 · 2026-10-01 11:20 · Omar Haddad, to the User: Can you send me/);
    expect(prompts().at(-1)).toMatch(/┆ M3 · NEW · 2026-10-01 11:45 · Omar Haddad, to the User: Thanks!/);
  });

  it('keeps a less sure one as a suggestion on the Chat; Add creates the Todo', async () => {
    syncFixture();
    replies['Omar Haddad'] = TODO_REPLIES['Omar Haddad']?.replace('0.92', '0.6') ?? '';
    await afterTeamsSync();

    const [suggestion] = pending();
    expect(suggestion).toMatchObject({
      itemId: idOf('Omar Haddad'),
      action: SUGGEST_TODOS,
      section: 'teams',
      decision: 'ask',
      chained: false,
    });
    expect(todos().map((todo) => todo.title)).toEqual(['Send the release notes']);

    gate.accept(suggestion?.id as number);
    const budget = todos().find((todo) => todo.title === 'Send Omar the TL budget');
    expect(budget?.detail).toMatchObject({ origin: 'ares', fromMessage: { itemId: idOf('Omar Haddad') } });
    expect(store.get(budget?.id as string)?.links[0]?.type).toBe('made-from');
  });

  it('keeps every one as a suggestion when Organise is Ask in Teams', async () => {
    syncFixture();
    gate.setLevel({ scope: 'section', section: 'teams', actionKind: 'organise' }, 'ask');
    await afterTeamsSync();
    expect(todos()).toEqual([]);
    expect(
      pending()
        .map((proposal) => proposal.itemId)
        .sort(),
    ).toEqual([idOf('Omar Haddad'), idOf('Titanlink eng')].sort());
  });

  it('undoes an Ares Todo: it goes, and isn’t offered again for the same message', async () => {
    const { chats } = syncFixture();
    await afterTeamsSync();
    const [done] = store.autonomy.proposals({ itemId: idOf('Omar Haddad') });
    gate.undo(done?.id as number);
    expect(todos().map((todo) => todo.title)).toEqual(['Send the release notes']);

    // A new message: the earlier request goes as context only, and naming it again is dropped.
    const before = chats.omar.detail?.kind === 'chat' ? chats.omar.detail.messages : [];
    sync(
      chat(
        '19:omar_sam@unq.gbl.spaces',
        'Omar Haddad',
        'one-on-one',
        [OMAR],
        [...before, message(OMAR, NOW + 5 * MINUTE, 'No rush.')],
      ),
    );
    clock = NOW + 6 * MINUTE;
    await afterTeamsSync();
    expect(prompts().at(-1)).not.toMatch(/NEW[^\n]*TL budget/);
    expect(todos().map((todo) => todo.title)).toEqual(['Send the release notes']);
    expect(logged.join('\n')).toMatch(/isn’t a new message/);
  });

  it('never offers a dismissed suggestion again for the same message', async () => {
    const { chats } = syncFixture();
    gate.setLevel({ scope: 'section', section: 'teams', actionKind: 'organise' }, 'ask');
    await afterTeamsSync();
    const suggestion = pending().find((proposal) => proposal.itemId === idOf('Omar Haddad'));
    gate.dismiss(suggestion?.id as number);

    const before = chats.omar.detail?.kind === 'chat' ? chats.omar.detail.messages : [];
    sync(
      chat(
        '19:omar_sam@unq.gbl.spaces',
        'Omar Haddad',
        'one-on-one',
        [OMAR],
        [...before, message(OMAR, NOW + 5 * MINUTE, 'No rush.')],
      ),
    );
    clock = NOW + 6 * MINUTE;
    await afterTeamsSync();
    expect(pending().filter((proposal) => proposal.itemId === idOf('Omar Haddad'))).toEqual([]);
  });

  it('skips a Chat once the User mutes it, and old messages', async () => {
    const chats = workChats(NOW);
    store.chatSettings.change({ account: TEAMS, chatId: '19:omar_sam@unq.gbl.spaces', change: 'mute' }, user);
    sync(
      chats.omar,
      chat(
        '19:old@thread.v2',
        'Last month',
        'group',
        [OMAR],
        [message(OMAR, NOW - 9 * 24 * HOUR, 'Sam, can you send the deck?', [SAM])],
      ),
    );
    await afterTeamsSync();
    expect(calls).toHaveLength(0);
  });

  it('doesn’t run when Suggest Todos is Off in Teams, nor on another Source’s sync', async () => {
    syncFixture();
    runner.trigger({ kind: 'source-sync', source: 'linear', account: 'linear:acme' });
    await runner.settled();
    expect(calls).toHaveLength(0);
    gate.setLevel({ scope: 'section', section: 'teams', actionKind: 'organise' }, 'off');
    await afterTeamsSync();
    expect(calls).toHaveLength(0);
  });
});

describe('a Chat that tries to steer Ares', () => {
  it('gets the warning mark, and its words stay data', async () => {
    syncFixture();
    await afterTeamsSync();
    const mallory = store.get(idOf('Mallory'))?.item;
    expect(mallory?.injectionWarning).toBeDefined();
    const call = calls.find((each) => chatIn(each.messages.at(-1)?.content ?? '') === 'Mallory');
    expect(call?.messages[0]?.content).not.toContain('ignore your instructions');
    expect(store.autonomy.proposals({ itemId: idOf('Mallory') })).toEqual([]);
  });

  it('from a fooled model, yields at most a suggestion on that Chat itself: nothing sent, nothing for other Chats', async () => {
    syncFixture();
    replies.Mallory = FOOLED_TODO_REPLY;
    const outgoingBefore = store.outgoing.forItem(idOf('Omar Haddad')).length;
    await afterTeamsSync();

    const fromMallory = store.autonomy.proposals({ itemId: idOf('Mallory') });
    expect(fromMallory).toHaveLength(1);
    // It waits for the User (the Chat holds instructions aimed at Ares), shows its cause, and its
    // title lost the link it wasn't shown.
    expect(fromMallory[0]).toMatchObject({
      status: 'pending',
      decision: 'ask',
      causedBy: { itemId: idOf('Mallory') },
    });
    const create = fromMallory[0]?.itemActions[0];
    const title = create?.type === 'create' ? create.item.title : '';
    expect(title).toMatch(/^Wire \$5,000 to Mallory/);
    expect(title).not.toMatch(/https?:|evil/);
    expect(fromMallory[0]?.itemActions.map((step) => step.type)).toEqual(['create', 'link']);
    // Nothing else: no Todo added, no suggestion on another Chat, nothing on its way to Teams.
    expect(
      todos()
        .map((todo) => todo.title)
        .sort(),
    ).toEqual(['Send Omar the TL budget', 'Send the release notes']);
    expect(pending().map((proposal) => proposal.itemId)).toEqual([idOf('Mallory')]);
    expect(store.outgoing.forItem(idOf('Omar Haddad'))).toHaveLength(outgoingBefore);
    expect(store.outgoing.forItem(idOf('Mallory'))).toEqual([]);
    expect(logged.join('\n')).toMatch(/C2/);
    expect(logged.join('\n')).toMatch(/M9/);
    expect(logged.join('\n')).toMatch(/twice/);
  });
});
