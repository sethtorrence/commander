import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ActionContext,
  ChatDetail,
  ChatMember,
  Project,
  RuleCondition,
  SourceItem,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Rules filing Teams Chats (#108): each Teams field matches Chats saved from Teams sync, a Rule
// files them as they arrive ("filed under TL by Rule: person in Chat is Omar Haddad"), a new Rule's
// re-filing preview includes Chats, and a Chat the User filed by hand is never moved.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const TEAMS = 'teams:tenant-1:u-sam';
const user: ActionContext = { by: { kind: 'user' } };

const SAM: ChatMember = { userId: 'u-sam', name: 'Sam Rivera', email: 'sam@contoso.test' };
const OMAR: ChatMember = { userId: 'u-omar', name: 'Omar Haddad', email: 'omar@titanlink.io' };
const PRIYA: ChatMember = { userId: 'u-priya', name: 'Priya Patel', email: 'priya@contoso.test' };

let dir: string;
let clock: number;
let store: ItemStore;
let tl: Project;
let tx: Project;

type ChatInput = { id: string; title: string; members?: ChatMember[]; chatType?: ChatDetail['chatType'] };

function chat({ id, title, members = [SAM, PRIYA], chatType = 'group' }: ChatInput): SourceItem {
  return {
    externalId: id,
    kind: 'chat',
    title,
    people: members.flatMap((member) => [`teams:${member.userId}`, member.email as string]),
    detail: {
      kind: 'chat',
      chatType,
      topic: chatType === 'one-on-one' ? null : title,
      webUrl: null,
      members,
      lastReadAt: null,
      hidden: false,
      joinUrl: null,
      messages: [],
      unreadCount: 0,
      mentionsMe: false,
      latestFromMe: false,
      lastMessageAt: null,
    },
  };
}

// Saves Chats as Teams sync does; returns their Item ids by Teams id.
function sync(...chats: ChatInput[]): Record<string, string> {
  clock += 1000;
  store.saveFromSource({ source: 'teams', account: TEAMS, items: chats.map(chat) });
  return Object.fromEntries(store.query({ kinds: ['chat'] }).map((item) => [item.externalId, item.id]));
}

function addRule(project: Project, condition: RuleCondition) {
  clock += 1000;
  return store.changeRule({
    type: 'create',
    rule: { target: { kind: 'project', projectId: project.id }, when: { join: 'and', terms: [condition] } },
  });
}

const filingOf = (id: string | undefined) => store.get(id ?? '')?.item.filing ?? null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-teams-rules-'));
  clock = Date.UTC(2026, 9, 3, 9);
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
  const project = (name: string, code: string) =>
    store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project as Project;
  tl = project('Titanlink', 'TL');
  tx = project('Tactics', 'TX');
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Rules filing Teams Chats', () => {
  it.each<[string, RuleCondition]>([
    ['Account', { field: 'teams.account', op: 'is', value: TEAMS, label: 'sam@contoso.test' }],
    ['Chat', { field: 'teams.chat', op: 'is', value: '19:tl-eng', label: 'TL eng' }],
    ['person in Chat', { field: 'teams.person', op: 'is', value: 'omar@titanlink.io', label: 'Omar Haddad' }],
    ['Chat type', { field: 'teams.chat-type', op: 'is', value: 'group', label: 'group' }],
    ['Chat name', { field: 'teams.title', op: 'contains', value: 'tl eng', label: 'TL eng' }],
  ])('files a Chat by its %s as it arrives, logging the Rule', (_name, condition) => {
    const rule = addRule(tl, condition).rule;

    const ids = sync(
      { id: '19:tl-eng', title: 'TL eng', members: [SAM, OMAR, PRIYA] },
      { id: '19:priya', title: 'Priya Patel', members: [SAM, PRIYA], chatType: 'one-on-one' },
    );

    expect(filingOf(ids['19:tl-eng'])).toEqual({ projectId: tl.id, filedBy: 'rule' });
    const [entry] = store.activity({ itemId: ids['19:tl-eng'] as string });
    expect(entry).toMatchObject({ by: { kind: 'rule', ruleId: rule?.id }, action: 'update' });
    expect(entry?.why).toMatch(/^Rule: /);
    // Only the Account names every Chat in it.
    if (condition.field !== 'teams.account') expect(filingOf(ids['19:priya'])).toBeNull();
  });

  it('never matches the User themself as a person in the Chat', () => {
    addRule(tl, { field: 'teams.person', op: 'is', value: 'sam@contoso.test', label: 'Sam Rivera' });
    const ids = sync({ id: '19:tl-eng', title: 'TL eng', members: [SAM, OMAR] });
    expect(filingOf(ids['19:tl-eng'])).toBeNull();
  });

  it('previews and re-files existing Chats for a new Rule, skipping one the User filed by hand', () => {
    const ids = sync(
      { id: '19:tl-eng', title: 'TL eng', members: [SAM, OMAR] },
      { id: '19:omar', title: 'Omar Haddad', members: [SAM, OMAR], chatType: 'one-on-one' },
      { id: '19:priya', title: 'Priya Patel', members: [SAM, PRIYA], chatType: 'one-on-one' },
    );
    store.record(
      {
        type: 'update',
        itemId: ids['19:omar'] as string,
        changes: { filing: { projectId: tx.id, filedBy: 'user' } },
      },
      user,
    );
    const draft = {
      target: { kind: 'project' as const, projectId: tl.id },
      when: {
        join: 'and' as const,
        terms: [
          { field: 'teams.person', op: 'is' as const, value: 'omar@titanlink.io', label: 'Omar Haddad' },
        ],
      },
    };

    // The editor's live count holds both Chats with Omar; re-filing offers only the one not hand-filed.
    const preview = store.previewRule({ rule: draft });
    expect(preview.count).toBe(2);
    expect(preview.sample.map((ref) => ref.id).sort()).toEqual([ids['19:tl-eng'], ids['19:omar']].sort());
    const made = store.changeRule({ type: 'create', rule: draft });
    expect(made.refile.map((each) => each.item.id)).toEqual([ids['19:tl-eng']]);

    store.refile(made.refile.map((each) => each.item.id));
    expect(filingOf(ids['19:tl-eng'])).toEqual({ projectId: tl.id, filedBy: 'rule' });
    expect(filingOf(ids['19:omar'])).toEqual({ projectId: tx.id, filedBy: 'user' });
    expect(filingOf(ids['19:priya'])).toBeNull();
  });
});
