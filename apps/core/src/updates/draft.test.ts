import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DRAFT_EMAIL_REPLIES, DRAFT_REPLIES, DRAFT_SKILL } from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowCloudMail, deliver } from '../agent/fixtures/emails';
import { SAM, TEAMS } from '../agent/fixtures/teams-chats';
import { REPLY_DRAFT, workChats } from '../agent/fixtures/teams-work';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { setUpUpdates, type Updates } from '.';

// Draft on request (#110) through the Updates bridge, as the Chat view asks for it: the Draft Skill,
// answering the window's `draft-reply` request, and never while "Draft replies" is Off. An email thread
// (#143) is drafted for through `draft-email-reply` and the same Skill, with what the User wants said.

const NOW = new Date(2026, 9, 1, 11, 40).getTime();

let dir: string;
let store: ItemStore;
let gate: Gate;
let updates: Updates;
let calls: ProviderRequest[];
let sent: unknown[];

const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    const email = request.messages[0]?.content.includes('email threads');
    const text = email
      ? JSON.stringify({ body: 'Hi Dana,\n\nYes, Thursday.\n\nAlex', confidence: 0.9, steering: [] })
      : REPLY_DRAFT;
    return { text, usage: { inputTokens: 1800, cachedTokens: 0, outputTokens: 80 } };
  },
  stream: () => Promise.reject(new Error('not used')),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-updates-draft-'));
  calls = [];
  sent = [];
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => NOW,
  });
  gate = openGate({ itemStore: store });
  gate.registerAction({ action: DRAFT_REPLIES, actionKind: 'organise', name: 'Draft replies' });
  updates = setUpUpdates({
    itemStore: store,
    gate,
    client: createModelClient({
      settings: () => store.models.settings(),
      providers: { zai: provider },
      ledger: store.models,
      now: () => NOW,
    }),
    now: () => NOW,
    me: (account) => (account === TEAMS ? SAM.userId : null),
    send: (message) => sent.push(message),
    log: () => {},
  });
  store.saveFromSource({
    source: 'teams',
    account: TEAMS,
    me: SAM.userId,
    items: [workChats(NOW).omar],
    deleted: [],
  });
});

afterEach(() => {
  updates.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const omar = () => store.query({ kinds: ['chat'] })[0]?.id as string;

describe('Draft on request', () => {
  it('answers the window’s request with a draft, and is one of Ares’s Skills', async () => {
    updates.handle({ type: 'updates-request', id: 3, request: { op: 'draft-reply', itemId: omar() } });
    await expect.poll(() => sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'updates-reply',
      id: 3,
      response: {
        ok: true,
        result: { itemId: omar(), text: 'Hi Omar, yes: I’ll send you the TL budget by Friday.', at: NOW },
      },
    });
    expect(updates.skills.list()).toContainEqual(DRAFT_SKILL);
    await expect(updates.skills.run('draft', { itemId: omar() })).resolves.toMatchObject({ itemId: omar() });
  });

  it('drafts nothing while Draft replies is Off', async () => {
    gate.setLevel({ scope: 'action', action: DRAFT_REPLIES }, 'off');
    await expect(updates.draft(omar())).rejects.toThrow(/Drafting replies is Off/);
    expect(calls).toHaveLength(0);
  });
});

describe('Draft a reply to an email thread', () => {
  it('answers the window’s request with the thread’s suggested reply, and the Draft Skill takes an instruction', async () => {
    allowCloudMail(store);
    const ids = deliver(store, NOW, [
      { id: 'offsite', subject: 'Q4 offsite dates', text: 'Which dates work?' },
    ]);
    const message = ids.offsite as string;
    updates.handle({
      type: 'updates-request',
      id: 4,
      request: { op: 'draft-email-reply', itemId: message },
    });
    await expect.poll(() => sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'updates-reply',
      id: 4,
      response: {
        ok: true,
        result: { state: 'ready', answering: message, body: 'Hi Dana,\n\nYes, Thursday.\n\nAlex' },
      },
    });

    await expect(
      updates.skills.run('draft', { itemId: message, instruction: 'Say yes, Thursday' }),
    ).resolves.toMatchObject({
      state: 'ready',
      answering: message,
    });
    expect(calls.at(-1)?.messages.at(-1)?.content).toContain('Say yes, Thursday');
    expect(store.models.usageSummary().byJob.map((row) => row.job)).toEqual([DRAFT_EMAIL_REPLIES]);
  });
});
