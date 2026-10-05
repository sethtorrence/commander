import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActionContext, type Project, ruleSuggestionDraft } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issue, pullRequest, syncGitHub } from '../agent/testing/github-fixtures';
import { type ItemStore, openItemStore } from '../item-store';
import { templateText } from './compose';
import { createUpdateQueue, type UpdateQueue } from './queue';
import { createRuleSuggestions } from './rule-suggestions';

// "Suggest rules" for GitHub Items (#118): five consistent answers to Ares's filing of pull requests
// and issues from one repo queue "Always file acme/titanlink-api under TL?", as they do for Linear
// teams. On a real database, with the answers recorded as the Item store records them.

const user: ActionContext = { by: { kind: 'user' } };
const NOW = Date.UTC(2026, 9, 3, 12);
const WEB = { nodeId: 'R_web', owner: 'acme', name: 'web' };

let dir: string;
let store: ItemStore;
let queue: UpdateQueue;
let suggestions: ReturnType<typeof createRuleSuggestions>;
let lt: Project;
let tl: Project;
let next = 1;

function project(name: string, code: string): Project {
  return store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project as Project;
}

// A pull request (or, every other time, an issue) from the API repo, or from another.
function githubItem(repo?: typeof WEB): string {
  const n = next++;
  const item = n % 2 ? pullRequest(NOW, n, `Change ${n}`) : issue(NOW, n, `Problem ${n}`);
  if (repo && item.detail && 'repo' in item.detail) {
    item.detail = { ...item.detail, repo };
    item.externalId = item.externalId.replace('R_api', repo.nodeId);
  }
  syncGitHub(store, [item]);
  const found = store.query({ source: 'github', titleContains: item.title, limit: 5 });
  return found.find((each) => each.title === item.title)?.id as string;
}

// Ares suggested one Project and the User chose another (a correction), or kept it.
function answer(itemId: string, from: Project, to: Project) {
  store.record(
    { type: 'update', itemId, changes: { filing: { projectId: from.id, filedBy: 'ares' } } },
    { by: { kind: 'ares' } },
  );
  store.record({ type: 'update', itemId, changes: { filing: { projectId: to.id, filedBy: 'user' } } }, user);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-github-rule-suggestions-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
  });
  lt = project('Longtail', 'LT');
  tl = project('Titanlink', 'TL');
  queue = createUpdateQueue({ store: store.updates });
  suggestions = createRuleSuggestions({ itemStore: store, queue });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Rule suggestions for GitHub Items', () => {
  it('five consistent answers on one repo queue "Always file acme/titanlink-api under TL?", naming the repo', () => {
    for (let i = 0; i < 5; i++) answer(githubItem(), lt, tl);
    suggestions.sweep();
    const lines = queue.list().filter((each) => each.about.kind === 'rule-suggestion');
    // The repo, not its org: the more specific field for the same Items.
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatchObject({
      group: 'decision',
      section: 'github',
      about: { field: 'github.repo', value: 'R_api', label: 'acme/titanlink-api', code: 'TL', count: 5 },
    });
    expect(templateText(line as never, () => null)).toBe(
      'You filed 5 GitHub Items from acme/titanlink-api under TL. Always file acme/titanlink-api under TL?',
    );
    // Accepting makes the repo Rule, which then files the next pull request from it.
    store.changeRule({ type: 'create', rule: ruleSuggestionDraft(line?.about as never) });
    expect(store.get(githubItem())?.item.filing).toMatchObject({ projectId: tl.id, filedBy: 'rule' });
  });

  it('offers the org when answers across its repos agree', () => {
    for (let i = 0; i < 3; i++) answer(githubItem(), lt, tl);
    for (let i = 0; i < 3; i++) answer(githubItem(WEB), lt, tl);
    suggestions.sweep();
    const [line] = queue.list().filter((each) => each.about.kind === 'rule-suggestion');
    expect(line?.about).toMatchObject({ field: 'github.org', value: 'acme', label: 'acme', count: 6 });
    expect(templateText(line as never, () => null)).toBe(
      'You filed 6 GitHub Items from org acme under TL. Always file GitHub org acme under TL?',
    );
  });
});
