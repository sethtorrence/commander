import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatReplySuggestionOf, DRAFT_REPLIES, REPLY_IN_TEAMS, type SourceItem } from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { type Agent, setUpAgent } from '.';
import { chat, MINUTE, message, OMAR, SAM, TEAMS } from './fixtures/teams-chats';
import { REPLY_DRAFT, workChats } from './fixtures/teams-work';

// The Agent's Teams work (#110), as the Core runs it: after a Teams sync Ares flags the Chat waiting
// on the User, and its suggested reply follows at once, without another sync; once the User answers
// in Teams, the flag and the suggestion go. Real Item store and gate; a fake provider answering each
// job by its instructions.

const NOW = new Date(2026, 9, 1, 11, 40).getTime();
const REASON = 'Omar asked you for the TL budget by Friday';

let dir: string;
let clock: number;
let store: ItemStore;
let gate: Gate;
let agent: Agent;
let calls: ProviderRequest[];

const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    const system = request.messages[0]?.content ?? '';
    const prompt = request.messages.at(-1)?.content ?? '';
    let text = '{"todos":[]}';
    if (system.includes('spot when someone is waiting on the User')) {
      const ref = /label="(W\d+) · Teams one-to-one chat: Omar Haddad"/.exec(prompt)?.[1];
      const asked = /┆ (M\d+) · [^\n]*TL budget/.exec(prompt)?.[1];
      text = JSON.stringify({
        chats: ref && asked ? [{ itemId: ref, waiting: true, messageId: asked, reason: REASON }] : [],
      });
    } else if (system.includes('draft a reply')) text = REPLY_DRAFT;
    else if (system.includes("rank the User's Dashboard")) text = '{"ranking":[]}';
    return { text, usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 } };
  },
  stream: () => Promise.reject(new Error('not used')),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-agent-teams-'));
  clock = NOW;
  calls = [];
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  gate = openGate({ itemStore: store });
  agent = setUpAgent(store, {
    gate,
    client: createModelClient({
      settings: () => store.models.settings(),
      providers: { zai: provider },
      ledger: store.models,
      now: () => clock,
    }),
    send: () => {},
    now: () => clock,
    me: () => SAM.userId,
    log: () => {},
  });
});

afterEach(() => {
  agent.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function synced(...items: SourceItem[]) {
  store.saveFromSource({ source: 'teams', account: TEAMS, me: SAM.userId, items, deleted: [] });
  agent.synced({ source: 'teams', account: TEAMS, outcome: 'synced', itemIds: [] });
  await agent.runner.settled();
  await agent.runner.settled();
}

const suggestions = () =>
  gate
    .activity({ action: REPLY_IN_TEAMS, statuses: ['pending'] })
    .flatMap((row) => chatReplySuggestionOf(row) ?? []);

describe('the Agent’s Teams work', () => {
  it('suggests a reply as soon as Ares flags a Chat, and withdraws it once the User answers in Teams', async () => {
    const chats = workChats(NOW);
    await synced(chats.omar);
    expect(store.chatWaiting.flagged().map((flag) => flag.reason)).toEqual([REASON]);
    expect(suggestions().map((each) => each.reply.text)).toEqual([
      'Hi Omar, yes: I’ll send you the TL budget by Friday.',
    ]);

    // The User answers in Teams: the flag goes at once with the sync, and so does the suggestion.
    clock = NOW + 10 * MINUTE;
    const before = chats.omar.detail?.kind === 'chat' ? chats.omar.detail.messages : [];
    await synced(
      chat(
        '19:omar_sam@unq.gbl.spaces',
        'Omar Haddad',
        'one-on-one',
        [OMAR],
        [...before, message(SAM, NOW + 9 * MINUTE, 'On it, Friday it is.')],
      ),
    );
    expect(store.chatWaiting.flagged()).toEqual([]);
    expect(suggestions()).toEqual([]);
  });

  it('lists Draft replies and Reply in Teams in the Settings grid', () => {
    const actions = gate.actions();
    expect(actions).toContainEqual(
      expect.objectContaining({ action: DRAFT_REPLIES, actionKind: 'organise' }),
    );
    expect(actions).toContainEqual(
      expect.objectContaining({ action: REPLY_IN_TEAMS, actionKind: 'act-for-you' }),
    );
  });
});
