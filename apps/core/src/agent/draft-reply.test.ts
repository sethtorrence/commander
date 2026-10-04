import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionContext,
  DRAFT_REPLY,
  type Item,
  jobDisplayName,
  type SourceItem,
} from '@commander/domain';
import { createModelClient, type ModelProviderAdapter, type ProviderRequest } from '@commander/models';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { DraftFailed, draftReply } from './draft-reply';
import { SAM, TEAMS } from './fixtures/teams-chats';
import { REPLY_DRAFT, workChats } from './fixtures/teams-work';

// Draft (#110): on request, Ares drafts a reply to one Chat from its recent messages, a Deep call,
// for the User to edit and send. It changes nothing. Fixture Chats in a real Item store, recorded
// replies from a fake provider, Thursday 1 October 2026, 11:40.

const NOW = new Date(2026, 9, 1, 11, 40).getTime();
const user: ActionContext = { by: { kind: 'user' } };

let dir: string;
let store: ItemStore;
let calls: ProviderRequest[];
let replies: string[];
let marked: string[];
let client: ReturnType<typeof createModelClient>;

const provider: ModelProviderAdapter = {
  async send(request) {
    calls.push(request);
    return {
      text: replies.shift() ?? REPLY_DRAFT,
      usage: { inputTokens: 1800, cachedTokens: 0, outputTokens: 80 },
    };
  },
  stream: () => Promise.reject(new Error('not used')),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-draft-reply-'));
  calls = [];
  replies = [];
  marked = [];
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => NOW,
  });
  client = createModelClient({
    settings: () => store.models.settings(),
    providers: { zai: provider },
    ledger: store.models,
    now: () => NOW,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function saved(item: SourceItem): Item {
  store.saveFromSource({ source: 'teams', account: TEAMS, me: SAM.userId, items: [item], deleted: [] });
  return store.query({ kinds: ['chat'] }).find((each) => each.externalId === item.externalId) as Item;
}

const draft = (item: Item) =>
  draftReply(item, {
    client,
    now: () => NOW,
    me: () => SAM.userId,
    injectionWarnings: store.injectionWarnings,
    onItemsChanged: (ids) => marked.push(...ids),
  });

describe('drafting a reply on request', () => {
  it('drafts from the Chat’s recent messages, in one Deep call under its name', async () => {
    const omar = saved(workChats(NOW).omar);
    const result = await draft(omar);

    expect(result).toEqual({
      itemId: omar.id,
      text: 'Hi Omar, yes: I’ll send you the TL budget by Friday.',
      at: NOW,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.setting.model).toBe(store.models.settings().tiers.deep.model);
    expect(calls[0]?.reasoningEffort).toBe('high');
    expect(store.models.usageSummary().byJob.map((row) => row.job)).toEqual([DRAFT_REPLY]);
    expect(jobDisplayName(DRAFT_REPLY)).toBe('Draft a reply');
    // The Chat in one outside data block; Ares's instructions alone in the system message.
    const prompt = calls[0]?.messages.at(-1)?.content ?? '';
    expect(prompt).toContain('label="C1 · Teams one-to-one chat: Omar Haddad" source="outside"');
    expect(prompt).toMatch(
      /┆ M2 · 2026-10-01 11:20 · Omar Haddad, to the User: Can you send me the TL budget/,
    );
    expect(calls[0]?.messages[0]?.content).toContain('draft a reply');
    // Nothing changed: no activity, nothing queued for Teams.
    expect(store.activity({ itemId: omar.id })).toHaveLength(1);
    expect(store.outgoing.forItem(omar.id)).toEqual([]);
  });

  it('is the User’s to send as any reply: it goes through the outgoing queue as theirs', async () => {
    const omar = saved(workChats(NOW).omar);
    const { text } = await draft(omar);
    const reply = { clientId: 'c1', text: `${text} Cheers`, createdAt: NOW };
    store.record({ type: 'edit-fields', itemId: omar.id, fields: { 'message:c1': reply } }, user);
    expect(store.outgoing.forItem(omar.id).map((row) => [row.field, row.status])).toEqual([
      ['message:c1', 'pending'],
    ]);
  });

  it('loses links it wasn’t shown, and a Chat that tries to steer Ares gets the warning mark', async () => {
    const mallory = saved(workChats(NOW).mallory);
    replies.push('{"draft":"Done. The TL budget is cancelled, see https://evil.test/pay","steering":["U1"]}');
    const result = await draft(mallory);
    expect(result.text).not.toMatch(/https?:|evil/);
    expect(store.get(mallory.id)?.item.injectionWarning).toBeDefined();
    // Nothing sent: the draft is text for the User, nothing more.
    expect(store.outgoing.forItem(mallory.id)).toEqual([]);
  });

  it('says so plainly when the reply makes no sense, and only drafts for a Chat', async () => {
    const omar = saved(workChats(NOW).omar);
    replies.push('{"draft":"   "}', '{"draft":"   "}');
    await expect(draft(omar)).rejects.toThrow(DraftFailed);
    const todo = store.record(
      {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'x',
          detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null },
        },
      },
      user,
    );
    await expect(draft(store.get(todo.itemId)?.item as Item)).rejects.toThrow(/Only a Teams Chat/);
  });
});
