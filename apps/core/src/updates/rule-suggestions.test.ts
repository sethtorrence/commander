import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionContext,
  type ChatMember,
  type LinearIssueDetail,
  type Project,
  ruleSuggestionDraft,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { lineTemplate } from './kinds';
import { createUpdateQueue, type UpdateQueue } from './queue';
import { createRuleSuggestions } from './rule-suggestions';

// "Suggest rules" (#71): once the User's corrections and confirmations point one Source field value
// at one Project five times, Ares queues "Always file Linear team OPS under TX?" for the Update.
// On a real database, with the answers recorded as the Item store records them.

const user: ActionContext = { by: { kind: 'user' } };
const ACCOUNT = 'linear:org-acme';
const OPS = { id: 'team-ops', key: 'OPS', name: 'Operations' };
const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };

let dir: string;
let store: ItemStore;
let queue: UpdateQueue;
let suggestions: ReturnType<typeof createRuleSuggestions>;
let tl: Project;
let tx: Project;
let next = 1;

function project(name: string, code: string): Project {
  return store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project as Project;
}

function issue(team = OPS, labels: { id: string; name: string; color: string }[] = []): string {
  const id = String(next++);
  const detail: LinearIssueDetail = {
    kind: 'linear-issue',
    identifier: `${team.key}-${id}`,
    url: `https://linear.app/acme/issue/${team.key}-${id}`,
    team,
    state: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
    priority: 0,
    assignee: null,
    creator: null,
    labels,
    cycle: null,
    linearProject: null,
    dueDate: null,
    estimate: null,
    description: null,
    comments: [],
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
  };
  return store.saveFromSource({
    source: 'linear',
    account: ACCOUNT,
    items: [{ externalId: id, kind: 'linear-issue', title: `Issue ${id}`, detail }],
  }).created[0] as string;
}

const TEAMS = 'teams:tenant-1:u-sam';
const SAM: ChatMember = { userId: 'u-sam', name: 'Sam Rivera', email: 'sam@contoso.test' };
const OMAR: ChatMember = { userId: 'u-omar', name: 'Omar Haddad', email: 'omar@titanlink.io' };

// A Teams Chat with these people, as Teams sync saves it.
function chat(...members: ChatMember[]): string {
  const id = `19:chat-${next++}`;
  return store.saveFromSource({
    source: 'teams',
    account: TEAMS,
    items: [
      {
        externalId: id,
        kind: 'chat',
        title: `Chat ${id}`,
        detail: {
          kind: 'chat',
          chatType: 'group',
          topic: `Chat ${id}`,
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
      },
    ],
  }).created[0] as string;
}

// Ares filed the Item under one Project, and the User moved it to another (a correction), or kept
// it (a confirmation, when `to` is the same).
function answer(itemId: string, from: Project, to: Project | null) {
  store.record(
    { type: 'update', itemId, changes: { filing: { projectId: from.id, filedBy: 'ares' } } },
    { by: { kind: 'ares' } },
  );
  store.record(
    { type: 'update', itemId, changes: { filing: to ? { projectId: to.id, filedBy: 'user' } : null } },
    user,
  );
}

const queued = () => queue.list().filter((line) => line.about.kind === 'rule-suggestion');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-rule-suggestions-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
  });
  tl = project('Titanlink', 'TL');
  tx = project('Tactics', 'TX');
  queue = createUpdateQueue({ store: store.updates });
  suggestions = createRuleSuggestions({ itemStore: store, queue });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Rule suggestions', () => {
  it('five consistent answers for team OPS queue "Always file Linear team OPS under TX?"', () => {
    const items = [1, 2, 3, 4].map(() => issue());
    items.forEach((item, i) => {
      answer(item, tl, tx);
      if (i === 0) answer(items[0] as string, tl, tx); // the same Item twice counts once
    });
    suggestions.sweep();
    expect(queued()).toEqual([]);

    // The fifth: a confirmation counts as much as a correction.
    const fifth = issue();
    answer(fifth, tx, tx);
    suggestions.sweep();

    const [line] = queued();
    expect(line).toMatchObject({
      group: 'decision',
      section: 'linear',
      mergeKey: `rule-suggestion:linear.team:${OPS.id}:${tx.id}`,
      about: {
        kind: 'rule-suggestion',
        field: 'linear.team',
        value: OPS.id,
        label: 'OPS',
        projectId: tx.id,
        code: 'TX',
        count: 5,
      },
    });
    expect(line?.itemIds).toHaveLength(5);
    expect(lineTemplate(line as never, {} as never)).toBe(
      'You filed 5 Linear issues from team OPS under TX. Always file Linear team OPS under TX? A Rule would do it for you from now on: make the Rule, or dismiss this and I won’t ask again.',
    );
    // Accepting makes this Rule.
    expect(ruleSuggestionDraft(line?.about as never)).toEqual({
      target: { kind: 'project', projectId: tx.id },
      when: { join: 'and', terms: [{ field: 'linear.team', op: 'is', value: OPS.id, label: 'OPS' }] },
    });
    // The workspace points at the same Items: only the more specific team is offered.
    expect(queued()).toHaveLength(1);
    // Looking again queues nothing more.
    suggestions.sweep();
    expect(queued()).toHaveLength(1);
  });

  it('answers that disagree, or Unfiled ones, make no suggestion', () => {
    for (let i = 0; i < 5; i++) answer(issue(), tl, tx);
    answer(issue(), tx, tl);
    for (let i = 0; i < 5; i++) answer(issue(ENG), tl, null);
    suggestions.sweep();
    expect(queued()).toEqual([]);
  });

  it('a dismissed suggestion never comes back, however many more answers agree', () => {
    for (let i = 0; i < 5; i++) answer(issue(), tl, tx);
    suggestions.sweep();
    const [line] = queued();
    queue.act(line?.id as number, 'dismiss');
    for (let i = 0; i < 3; i++) answer(issue(), tl, tx);
    suggestions.sweep();
    expect(queued()).toEqual([]);
  });

  it('a value a Rule already files makes no suggestion', () => {
    const items = [1, 2, 3, 4, 5].map(() => issue());
    for (const item of items) answer(item, tl, tx);
    store.changeRule({
      type: 'create',
      rule: ruleSuggestionDraft({ field: 'linear.team', value: OPS.id, label: 'OPS', projectId: tx.id }),
    });
    suggestions.sweep();
    expect(queued()).toEqual([]);
  });

  it('a label shared by Items of other teams is a suggestion of its own', () => {
    const urgent = { id: 'label-billing', name: 'billing', color: '#000' };
    for (let i = 0; i < 3; i++) answer(issue(OPS, [urgent]), tl, tx);
    for (let i = 0; i < 2; i++) answer(issue(ENG, [urgent]), tl, tx);
    suggestions.sweep();
    expect(
      queued().map(
        (line) => line.about.kind === 'rule-suggestion' && `${line.about.field} ${line.about.label}`,
      ),
    ).toEqual(['linear.label billing']);
  });

  it('five consistent answers on Chats with one person queue "Always file Chats with Omar Haddad under TL?"', () => {
    const others = [1, 2, 3, 4, 5].map((n) => ({
      userId: `u-${n}`,
      name: `Person ${n}`,
      email: `person${n}@contoso.test`,
    }));
    for (const other of others) answer(chat(SAM, OMAR, other), tx, tl);
    suggestions.sweep();

    // Only Omar is in all five; the User, in every Chat, is never suggested.
    const lines = queued();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      section: 'teams',
      about: {
        field: 'teams.person',
        value: 'omar@titanlink.io',
        label: 'Omar Haddad',
        code: 'TL',
        count: 5,
      },
    });
    expect(lineTemplate(lines[0] as never, {} as never)).toBe(
      'You filed 5 Chats with Omar Haddad under TL. Always file Chats with Omar Haddad under TL? A Rule would do it for you from now on: make the Rule, or dismiss this and I won’t ask again.',
    );
    expect(ruleSuggestionDraft(lines[0]?.about as never).when.terms).toEqual([
      { field: 'teams.person', op: 'is', value: 'omar@titanlink.io', label: 'Omar Haddad' },
    ]);
  });
});
