import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatDetail, LinearIssueDetail, Person, SourceItem } from '@commander/domain';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// People in the Item store (#117): matched across Sources after every save, by the email addresses
// Sources give for their handles; merged, split and renamed by the User, each change in the People
// log, which undoes it. Run against a real temporary database.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const LINEAR = 'linear:org-acme';
const GITHUB = 'github:42';
const TEAMS = 'teams:tenant-1:u-sam';
const T = Date.UTC(2026, 9, 4, 9);

let dir: string;
let store: ItemStore;

function open() {
  return openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => T,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-people-'));
  store = open();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

type LinearUser = { id: string; name: string; email: string | null };

function linearIssue(
  externalId: string,
  assignee: LinearUser | null,
  creator: LinearUser | null = null,
): SourceItem {
  const user = (who: LinearUser | null) => who && { ...who, displayName: who.name.split(' ')[0] ?? who.name };
  const detail = {
    kind: 'linear-issue',
    identifier: `ENG-${externalId}`,
    url: `https://linear.app/acme/issue/ENG-${externalId}`,
    team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
    state: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#ccc' },
    priority: 0,
    assignee: user(assignee),
    creator: user(creator),
    labels: [],
    cycle: null,
    linearProject: null,
    dueDate: null,
    estimate: null,
    description: null,
    comments: [],
    createdAt: T,
    updatedAt: T,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
  } satisfies LinearIssueDetail;
  const people = [assignee, creator].flatMap((who) =>
    who ? [`linear:${who.id}`, ...(who.email ? [who.email] : [])] : [],
  );
  return { externalId, kind: 'linear-issue', title: `Issue ${externalId}`, people, detail };
}

function pullRequest(
  externalId: string,
  author: string,
  email?: { email: string; name?: string },
): SourceItem {
  return {
    externalId,
    kind: 'pull-request',
    title: `PR ${externalId}`,
    people: [`github:${author}`, ...(email ? [email.email.toLowerCase()] : [])],
    identities: email ? [{ handle: `github:${author}`, email: email.email, name: email.name ?? null }] : [],
  };
}

function chat(externalId: string, members: { userId: string | null; name: string; email: string | null }[]) {
  const detail = {
    kind: 'chat',
    chatType: 'group',
    topic: 'Launch',
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
  } satisfies ChatDetail;
  const people = members.flatMap((member) => [
    ...(member.userId ? [`teams:${member.userId}`] : []),
    ...(member.email ? [member.email.toLowerCase()] : []),
  ]);
  return { externalId, kind: 'chat', title: 'Launch', people, detail } satisfies SourceItem;
}

const PRIYA: LinearUser = { id: 'u-priya', name: 'Priya Patel', email: 'priya@acme.io' };
const SAM: LinearUser = { id: 'u-sam', name: 'Sam Rivera', email: null };

const personOf = (handle: string): Person | undefined =>
  store.people.list().find((each) => each.handles.some((h) => h.handle === handle));
const handlesOf = (person: Person | undefined) => person?.handles.map((h) => h.handle).sort() ?? [];

describe('matching', () => {
  it('makes a Linear user and a GitHub login sharing an email one Person', () => {
    store.saveFromSource({ source: 'linear', account: LINEAR, items: [linearIssue('1', PRIYA)] });
    store.saveFromSource({
      source: 'github',
      account: GITHUB,
      items: [pullRequest('pr-1', 'Priya-P', { email: 'priya@acme.io', name: 'Priya P.' })],
    });
    const priya = personOf('github:priya-p');
    expect(handlesOf(priya)).toEqual(['github:priya-p', 'linear:u-priya', 'priya@acme.io']);
    expect(priya?.name).toBe('Priya Patel');
    expect(personOf('linear:u-priya')?.id).toBe(priya?.id);
  });

  it('keeps a handle with no email to itself until an email links it', () => {
    store.saveFromSource({ source: 'github', account: GITHUB, items: [pullRequest('pr-1', 'priya-p')] });
    store.saveFromSource({ source: 'linear', account: LINEAR, items: [linearIssue('1', PRIYA)] });
    expect(personOf('github:priya-p')?.id).not.toBe(personOf('linear:u-priya')?.id);
    expect(personOf('github:priya-p')?.name).toBe('priya-p');

    store.saveFromSource({
      source: 'github',
      account: GITHUB,
      items: [pullRequest('pr-2', 'priya-p', { email: 'priya@acme.io' })],
    });
    expect(personOf('github:priya-p')?.id).toBe(personOf('linear:u-priya')?.id);
    expect(store.people.list()).toHaveLength(1);
  });

  it('matches email addresses whatever their case', () => {
    store.saveFromSource({
      source: 'teams',
      account: TEAMS,
      items: [chat('chat-1', [{ userId: 't-priya', name: 'Priya Patel', email: 'Priya@ACME.io' }])],
    });
    store.saveFromSource({ source: 'linear', account: LINEAR, items: [linearIssue('1', PRIYA)] });
    expect(handlesOf(personOf('teams:t-priya'))).toEqual([
      'linear:u-priya',
      'priya@acme.io',
      'teams:t-priya',
    ]);
  });

  it('names a Person from the richest Source: Linear or Teams, then GitHub, then login or address', () => {
    store.saveFromSource({ source: 'github', account: GITHUB, items: [pullRequest('pr-1', 'li-w')] });
    expect(personOf('github:li-w')?.name).toBe('li-w');
    store.saveFromSource({
      source: 'github',
      account: GITHUB,
      items: [pullRequest('pr-2', 'li-w', { email: 'li@acme.io', name: 'Li W.' })],
    });
    expect(personOf('github:li-w')?.name).toBe('Li W.');
    store.saveFromSource({
      source: 'teams',
      account: TEAMS,
      items: [chat('chat-1', [{ userId: 't-li', name: 'Li Wei', email: 'li@acme.io' }])],
    });
    expect(personOf('github:li-w')?.name).toBe('Li Wei');
  });

  it('never joins People on a name alone', () => {
    store.saveFromSource({
      source: 'teams',
      account: TEAMS,
      items: [chat('chat-1', [{ userId: 't-sam', name: 'Sam Rivera', email: null }])],
    });
    store.saveFromSource({ source: 'linear', account: LINEAR, items: [linearIssue('1', SAM)] });
    expect(personOf('teams:t-sam')?.id).not.toBe(personOf('linear:u-sam')?.id);
  });

  it('matches the People of Items saved before People existed when the store opens', () => {
    store.saveFromSource({ source: 'linear', account: LINEAR, items: [linearIssue('1', PRIYA, SAM)] });
    store.close();
    // As a database from before #117 would be: Items with people, no People.
    const raw = new Database(join(dir, 'commander.db'));
    raw.exec('DELETE FROM person_handles; DELETE FROM people_changes; DELETE FROM people;');
    raw.close();
    store = open();
    expect(handlesOf(personOf('linear:u-priya'))).toEqual(['linear:u-priya', 'priya@acme.io']);
    expect(personOf('linear:u-sam')?.name).toBe('Sam Rivera');
  });
});

describe('merge, split and rename', () => {
  beforeEach(() => {
    store.saveFromSource({ source: 'linear', account: LINEAR, items: [linearIssue('1', PRIYA)] });
    store.saveFromSource({ source: 'github', account: GITHUB, items: [pullRequest('pr-1', 'pp-dev')] });
  });

  it('merges two People, keeping the name the User chose, and a later sync leaves them merged', () => {
    const priya = personOf('linear:u-priya') as Person;
    const dev = personOf('github:pp-dev') as Person;
    const change = store.people.change({
      type: 'merge',
      personId: dev.id,
      into: priya.id,
      name: 'Priya Patel',
    });
    expect(change.action).toBe('merge');
    expect(handlesOf(personOf('github:pp-dev'))).toEqual([
      'github:pp-dev',
      'linear:u-priya',
      'priya@acme.io',
    ]);
    expect(store.people.list()).toHaveLength(1);

    store.saveFromSource({ source: 'github', account: GITHUB, items: [pullRequest('pr-2', 'pp-dev')] });
    store.saveFromSource({ source: 'linear', account: LINEAR, items: [linearIssue('2', PRIYA)] });
    expect(store.people.list()).toHaveLength(1);
    expect(personOf('github:pp-dev')?.name).toBe('Priya Patel');
  });

  it('keeps the merged-away Person’s name when the User chooses it', () => {
    const priya = personOf('linear:u-priya') as Person;
    const dev = personOf('github:pp-dev') as Person;
    store.people.change({ type: 'merge', personId: priya.id, into: dev.id, name: 'pp-dev' });
    expect(personOf('linear:u-priya')).toMatchObject({ id: dev.id, name: 'pp-dev', userName: 'pp-dev' });
  });

  it('undoes a merge from the People log, bringing the earlier People back', () => {
    const priya = personOf('linear:u-priya') as Person;
    const dev = personOf('github:pp-dev') as Person;
    const merge = store.people.change({ type: 'merge', personId: dev.id, into: priya.id });
    const undo = store.people.change({ type: 'undo', changeId: merge.id });
    expect(undo).toMatchObject({ action: 'undo', undoes: merge.id });
    expect(personOf('github:pp-dev')).toMatchObject({ id: dev.id, name: 'pp-dev' });
    expect(handlesOf(personOf('linear:u-priya'))).toEqual(['linear:u-priya', 'priya@acme.io']);
    expect(() => store.people.change({ type: 'undo', changeId: merge.id })).toThrow(/already undone/);
    // Undoing the undo redoes the merge.
    store.people.change({ type: 'undo', changeId: undo.id });
    expect(store.people.list()).toHaveLength(1);
  });

  it('splits a handle out to a Person of its own, which matching never joins back', () => {
    store.saveFromSource({
      source: 'github',
      account: GITHUB,
      items: [pullRequest('pr-2', 'priya-p', { email: 'priya@acme.io' })],
    });
    const priya = personOf('github:priya-p') as Person;
    expect(personOf('linear:u-priya')?.id).toBe(priya.id);

    const split = store.people.change({ type: 'split', personId: priya.id, handles: ['github:priya-p'] });
    expect(split.otherId).not.toBeNull();
    expect(handlesOf(personOf('github:priya-p'))).toEqual(['github:priya-p']);
    expect(personOf('github:priya-p')?.id).toBe(split.otherId);

    // GitHub still says the login has Priya's address: the split stands.
    store.saveFromSource({
      source: 'github',
      account: GITHUB,
      items: [pullRequest('pr-3', 'priya-p', { email: 'priya@acme.io' })],
    });
    expect(personOf('github:priya-p')?.id).not.toBe(personOf('linear:u-priya')?.id);

    store.people.change({ type: 'undo', changeId: split.id });
    expect(personOf('github:priya-p')?.id).toBe(personOf('linear:u-priya')?.id);
    expect(store.people.list().map((each) => each.id)).not.toContain(split.otherId);
  });

  it('refuses to split every handle off a Person, or a handle they don’t have', () => {
    const priya = personOf('linear:u-priya') as Person;
    expect(() =>
      store.people.change({
        type: 'split',
        personId: priya.id,
        handles: ['linear:u-priya', 'priya@acme.io'],
      }),
    ).toThrow(/keep at least one/);
    expect(() =>
      store.people.change({ type: 'split', personId: priya.id, handles: ['github:pp-dev'] }),
    ).toThrow(/isn’t one of/);
  });

  it('lets a rename win over every Source’s name, through later syncs, until it is undone', () => {
    const priya = personOf('linear:u-priya') as Person;
    const rename = store.people.change({ type: 'rename', personId: priya.id, name: 'Pri' });
    expect(rename.person).toMatchObject({ name: 'Pri', userName: 'Pri' });
    store.saveFromSource({
      source: 'linear',
      account: LINEAR,
      items: [linearIssue('2', { ...PRIYA, name: 'Priya Patel-Shah' })],
    });
    expect(personOf('linear:u-priya')?.name).toBe('Pri');
    store.people.change({ type: 'undo', changeId: rename.id });
    expect(personOf('linear:u-priya')).toMatchObject({ name: 'Priya Patel-Shah', userName: null });
  });

  it('lists every change in the People log, newest first', () => {
    const priya = personOf('linear:u-priya') as Person;
    store.people.change({ type: 'rename', personId: priya.id, name: 'Pri' });
    expect(store.people.log().map((each) => each.action)).toEqual(['rename']);
  });
});

describe('the User', () => {
  it('is one Person across their Accounts, whatever the Sources call them', () => {
    store.saveFromSource({
      source: 'linear',
      account: LINEAR,
      items: [linearIssue('1', { id: 'u-me', name: 'Sam Rivera', email: null })],
    });
    store.saveFromSource({
      source: 'teams',
      account: TEAMS,
      items: [chat('chat-1', [{ userId: 't-me', name: 'Sam Rivera', email: 'sam@contoso.test' }])],
    });
    store.saveFromSource({ source: 'github', account: GITHUB, items: [pullRequest('pr-1', 'samr')] });
    store.people.recogniseUser([
      { handles: ['linear:u-me'], name: 'Sam Rivera' },
      { handles: ['teams:t-me', 'sam@contoso.test'], name: 'Sam Rivera' },
      { handles: ['github:samr'], name: 'Sam' },
    ]);
    const me = personOf('github:samr');
    expect(me?.isUser).toBe(true);
    expect(handlesOf(me)).toEqual(['github:samr', 'linear:u-me', 'sam@contoso.test', 'teams:t-me']);
    expect(store.people.list().filter((each) => each.isUser)).toHaveLength(1);
  });
});

describe('search', () => {
  it('finds People by name and by handle', () => {
    store.saveFromSource({ source: 'linear', account: LINEAR, items: [linearIssue('1', PRIYA, SAM)] });
    expect((store.search.query({ text: 'pri' }).people ?? []).map((each) => each.name)).toEqual([
      'Priya Patel',
    ]);
    expect((store.search.query({ text: 'priya@acme' }).people ?? []).map((each) => each.name)).toEqual([
      'Priya Patel',
    ]);
    expect(store.search.query({ text: 'pri', kinds: ['linear-issue'] }).people ?? []).toEqual([]);
  });
});
