import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type GitHubAccess, type GitHubRepo, githubExternalId, noWatch } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// What each GitHub Account watches, kept by the Item store (its only writer), and unwatching a repo
// removing its Items as removing an Account does: notes and Todos stay, with Links shown as gone.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const ACCOUNT = 'github:583231';

let dir: string;
let store: ItemStore;
let clock: number;

const open = () =>
  openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-github-watch-'));
  clock = Date.UTC(2026, 9, 3, 12);
  store = open();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const repo = (owner: string, name: string): GitHubRepo => ({
  nodeId: `R_${owner}_${name}`,
  owner,
  name,
  visibility: 'private',
  pushedAt: null,
});
const api = repo('acme', 'api');
const web = repo('acme', 'web');
const ref = ({ nodeId, owner, name }: GitHubRepo) => ({ nodeId, owner, name });

const access = (repos: GitHubRepo[]): GitHubAccess => ({
  via: 'app',
  login: 'octocat',
  orgs: [{ login: 'acme', id: 1, reach: 'installed', repos, addedByName: false, problem: null }],
  personal: [],
  fetchedAt: clock,
});

const savePullRequests = (account = ACCOUNT) =>
  store.saveFromSource({
    source: 'github',
    account,
    items: [
      { externalId: githubExternalId(api.nodeId, 'pr/1'), kind: 'pull-request', title: 'Retry webhooks' },
      { externalId: githubExternalId(api.nodeId, 'pr/2'), kind: 'pull-request', title: 'Bump node' },
      { externalId: githubExternalId(web.nodeId, 'pr/7'), kind: 'pull-request', title: 'New header' },
    ],
  });

describe('the selection, per Account', () => {
  it('is empty until anything is saved', () => {
    expect(store.githubWatch.read(ACCOUNT)).toEqual({
      watch: null,
      fromDefault: false,
      access: null,
      seen: [],
      addedOrgs: [],
    });
  });

  it('starts once with the default, which a later default never replaces', () => {
    store.githubWatch.startWith(ACCOUNT, { orgs: [], repos: [ref(api)] });
    store.githubWatch.startWith(ACCOUNT, { orgs: [], repos: [ref(web)] });
    expect(store.githubWatch.read(ACCOUNT)).toMatchObject({
      watch: { orgs: [], repos: [ref(api)] },
      fromDefault: true,
    });
  });

  it('keeps the User’s changes across restarts, apart from other Accounts', () => {
    store.githubWatch.startWith(ACCOUNT, noWatch());
    store.githubWatch.save(ACCOUNT, { orgs: [{ login: 'acme', except: [ref(web)] }], repos: [] });

    store.close();
    store = open();

    expect(store.githubWatch.read(ACCOUNT)).toMatchObject({
      watch: { orgs: [{ login: 'acme', except: [ref(web)] }], repos: [] },
      fromDefault: false,
    });
    expect(store.githubWatch.read('github:2').watch).toBeNull();
  });

  it('refuses a malformed selection', () => {
    expect(() => store.githubWatch.save(ACCOUNT, { orgs: [{ login: '' }] } as never)).toThrow();
  });

  it('keeps the last listing, and every repo it has ever listed', () => {
    store.githubWatch.saveAccess(ACCOUNT, access([api, web]));
    store.githubWatch.saveAccess(ACCOUNT, access([api]));
    const record = store.githubWatch.read(ACCOUNT);
    expect(record.access?.orgs[0]?.repos).toEqual([api]);
    expect(record.seen).toEqual([ref(api), ref(web)]);
  });

  it('remembers orgs added by name, once each', () => {
    store.githubWatch.addOrg(ACCOUNT, 'Globex');
    store.githubWatch.addOrg(ACCOUNT, 'globex');
    store.githubWatch.addOrg(ACCOUNT, 'initech');
    expect(store.githubWatch.read(ACCOUNT).addedOrgs).toEqual(['Globex', 'initech']);
  });

  it('is forgotten with its Account', () => {
    store.githubWatch.save(ACCOUNT, noWatch());
    store.githubWatch.forget(ACCOUNT);
    expect(store.githubWatch.read(ACCOUNT).watch).toBeNull();
  });
});

describe('unwatching', () => {
  it('counts the Items of the repos it would stop watching', () => {
    savePullRequests();
    savePullRequests('github:2');
    expect(store.githubWatch.countItems(ACCOUNT, [api.nodeId])).toBe(2);
    expect(store.githubWatch.countItems(ACCOUNT, [api.nodeId, web.nodeId])).toBe(3);
    expect(store.githubWatch.countItems(ACCOUNT, ['R_none'])).toBe(0);
  });

  it('removes those Items with the selection, as the User, leaving Todos linked to them with the Links shown as gone', () => {
    savePullRequests();
    savePullRequests('github:2');
    const [pr1] = store.query({ titleContains: 'Retry webhooks', account: ACCOUNT });
    if (!pr1) throw new Error('No pull request saved');
    const todo = store.record(
      { type: 'create', item: { kind: 'todo', title: 'Review the webhook PR' } },
      { by: { kind: 'user' } },
    );
    store.link({ from: todo.itemId, linkType: 'refers-to', to: pr1.id }, { by: { kind: 'user' } });

    const removed = store.githubWatch.save(ACCOUNT, noWatch(), {
      stop: [ref(api)],
      why: 'Stopped watching acme/api',
    });

    expect(removed).toHaveLength(2);
    expect(store.query({ source: 'github', account: ACCOUNT }).map((item) => item.title)).toEqual([
      'New header',
    ]);
    expect(store.query({ source: 'github', account: 'github:2' })).toHaveLength(3);
    expect(store.githubWatch.read(ACCOUNT).watch).toEqual(noWatch());
    // The Todo stays, and its Link now points at a removed Item.
    const view = store.get(todo.itemId);
    expect(view?.item.deletedAt).toBeNull();
    expect(view?.links[0]?.to).toMatchObject({ id: pr1.id, deletedAt: clock });
    expect(store.activity({ itemId: pr1.id })[0]).toMatchObject({
      action: 'delete',
      by: { kind: 'user' },
      why: 'Stopped watching acme/api',
    });
  });
});
