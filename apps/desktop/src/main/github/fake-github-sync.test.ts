import type { SourceItem } from '@commander/domain';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGitHubSource } from '../../../../../packages/sources/src/github/github-source';
import type { SyncPage, SyncWatch } from '../../../../../packages/sources/src/source';
import { type FakeGitHub, OCTOCAT, startFakeGitHub } from './fake-github-server';

// The fake GitHub answers GitHub sync (#114) as GitHub does, so the end-to-end tests can lean on it:
// the gates with ETags (a 304 when nothing changed), open work, search and the repo queries.

let github: FakeGitHub;
let token: string;

beforeEach(async () => {
  github = await startFakeGitHub();
  github.addOrg({ login: 'acme-org', id: 501, members: [OCTOCAT.id] });
  github.addRepo({ owner: 'acme-org', name: 'api', pushedAt: '2026-10-02T10:00:00Z' });
  github.addRepo({ owner: 'acme-org', name: 'web', pushedAt: '2026-09-20T10:00:00Z' });
  github.addTeam({ org: 'acme-org', slug: 'platform', members: [OCTOCAT.id] });
  github.addPullRequest({
    repo: 'acme-org/api',
    number: 12,
    title: 'Retry webhooks with back-off',
    body: 'Retries failed webhooks with exponential back-off.',
    author: 'priya',
    reviewers: ['octocat'],
    updatedAt: '2026-10-02T09:00:00Z',
  });
  github.addPullRequest({
    repo: 'acme-org/web',
    number: 7,
    title: 'Dark mode',
    author: 'sam',
    teams: ['acme-org/platform'],
    updatedAt: '2026-10-02T08:00:00Z',
  });
  github.addIssue({
    repo: 'acme-org/api',
    number: 30,
    title: 'Webhooks drop on 502',
    author: 'priya',
    assignees: ['octocat'],
  });
  github.addRelease({
    repo: 'acme-org/api',
    tag: 'v1.4.0',
    publishedAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
  github.addCommit({
    repo: 'acme-org/api',
    message: 'Revert "Cache the session lookups"',
    author: 'sam',
    committedAt: new Date(Date.now() - 3_600_000).toISOString(),
  });
  token = github.personalToken({ kind: 'classic' });
});

afterEach(async () => {
  await github.close();
});

const watch: SyncWatch = {
  selection: { orgs: [{ login: 'acme-org', except: [] }], repos: [] },
  orgs: ['acme-org'],
};

async function sync(cursor: unknown, held: SourceItem[] = []) {
  const pages: SyncPage[] = [];
  const source = createGitHubSource({ apiUrl: () => github.apiUrl });
  let catalog: unknown = null;
  const result = await source.sync({
    account: `github:${OCTOCAT.id}`,
    cursor,
    mode: 'full',
    accessToken: async () => ({ token, kind: 'api-key' }),
    save: (page) => pages.push(page),
    saveCatalog: (each) => {
      catalog = each;
    },
    watch,
    stored: (externalIds) =>
      held
        .filter((item) => externalIds.includes(item.externalId))
        .map((item) => ({
          externalId: item.externalId,
          title: item.title,
          people: item.people ?? [],
          status: item.status ?? 'open',
          detail: item.detail ?? null,
        })),
    signal: new AbortController().signal,
  });
  return { result, items: pages.flatMap((page) => page.items) as SourceItem[], catalog };
}

it('syncs pull requests, issues, review requests and releases, then finds nothing changed', async () => {
  const first = await sync(null);
  expect(new Set(first.items.map((item) => `${item.kind} ${item.title}`))).toEqual(
    new Set([
      'pull-request Retry webhooks with back-off',
      'pull-request Dark mode',
      'github-issue Webhooks drop on 502',
      'review-request Retry webhooks with back-off',
      'review-request Dark mode',
      'github-release api v1.4.0',
    ]),
  );
  expect(first.catalog).toMatchObject({ kind: 'github', repos: [{ commits: [{ revert: true }] }, {}] });

  const before = github.apiRequests.length;
  const again = await sync(first.result.cursor, first.items);
  const asked = github.apiRequests.slice(before);
  expect(asked.filter((each) => each.startsWith('GET'))).toEqual([
    'GET /user/teams 304',
    'GET /orgs/acme-org/repos 304',
    'GET /orgs/acme-org/issues 304',
  ]);
  expect(asked.filter((each) => each.startsWith('POST'))).toEqual(['POST /graphql CommanderOpenWork']);
  expect(again.result.cost).toEqual({ requests: 0, complexity: 1 });
});

it('answers a map’s sub-issues, milestones, claims and blockers as GitHub does (#120)', async () => {
  github.addIssue({
    repo: 'acme-org/api',
    number: 1,
    title: 'v1 map',
    author: 'octocat',
    labels: ['wayfinder:map'],
  });
  github.addIssue({
    repo: 'acme-org/api',
    number: 2,
    title: 'Research',
    author: 'octocat',
    labels: ['wayfinder:research'],
    parent: 1,
    state: 'CLOSED',
    stateReason: 'NOT_PLANNED',
    // Closed yesterday, so it stays inside the first sync's 30 days whenever the test runs.
    updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
  github.addIssue({
    repo: 'acme-org/api',
    number: 3,
    title: 'Grill',
    author: 'octocat',
    labels: ['wayfinder:grilling'],
    parent: 1,
    milestone: 'M4',
    assignees: ['priya'],
    assignedAt: '2026-10-02T08:00:00Z',
    blockedBy: [2, 30],
  });
  const { items } = await sync(null);
  const detail = (number: number) =>
    items.find((item) => item.externalId.endsWith(`:issue/${number}`))?.detail as Record<string, unknown>;
  expect(detail(1)).toMatchObject({ subIssues: { total: 2, completed: 1 }, parent: null });
  expect(detail(2)).toMatchObject({ state: 'closed', stateReason: 'not-planned', parent: { number: 1 } });
  expect(detail(3)).toMatchObject({
    milestone: { title: 'M4', issues: { open: 1, closed: 0 } },
    claimedAt: Date.parse('2026-10-02T08:00:00Z'),
    blockedBy: [
      { owner: 'acme-org', name: 'api', number: 2, state: 'closed' },
      { owner: 'acme-org', name: 'api', number: 30, state: 'open' },
    ],
  });
});
