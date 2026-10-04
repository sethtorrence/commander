import { afterEach, beforeEach, expect, it } from 'vitest';
import { readGitHubDiscussion } from '../../../../../packages/sources/src/github/discussion';
import { type FakeGitHub, OCTOCAT, startFakeGitHub } from './fake-github-server';

// The fake GitHub answers the GitHub Section's discussion query (#115) as GitHub does, so the
// end-to-end tests can lean on it: comments, reviews, review comments and a pull request's checks.

let github: FakeGitHub;
let token: string;

beforeEach(async () => {
  github = await startFakeGitHub();
  github.addOrg({ login: 'acme-org', id: 501, members: [OCTOCAT.id] });
  github.addRepo({ owner: 'acme-org', name: 'api', pushedAt: '2026-10-02T10:00:00Z' });
  github.addPullRequest({
    repo: 'acme-org/api',
    number: 12,
    title: 'Retry webhooks with back-off',
    author: 'priya',
    updatedAt: '2026-10-02T09:00:00Z',
    checkRuns: [
      { name: 'test', conclusion: 'FAILURE', url: 'https://ci.acme.test/runs/1' },
      { name: 'lint', conclusion: null },
    ],
    reviews: [{ author: 'omar', state: 'APPROVED', body: 'Ship it', submittedAt: '2026-10-02T08:30:00Z' }],
  });
  github.addIssue({ repo: 'acme-org/api', number: 30, title: 'Webhooks drop on 502', author: 'priya' });
  token = github.personalToken({ kind: 'classic' });
});

afterEach(async () => {
  await github.close();
});

it('answers a pull request’s discussion and checks, and counts the query', async () => {
  const before = Date.now();
  github.addComment('acme-org/api', 12, {
    author: 'omar',
    body: 'Can we keep the old flag?',
    createdAt: '2026-10-02T08:00:00Z',
  });
  github.addComment('acme-org/api', 12, {
    author: 'priya',
    body: 'Done.',
    createdAt: '2026-10-02T09:30:00Z',
    path: 'src/retry.ts',
    line: 42,
  });

  const found = await readGitHubDiscussion(
    { apiUrl: github.apiUrl, token: { token, kind: 'oauth' } },
    { kind: 'pull-request', nodeId: 'PR_fake_acme-org_api_12' },
  );

  expect(found.entries.map((entry) => [entry.kind, entry.author, entry.body])).toEqual([
    ['comment', 'omar', 'Can we keep the old flag?'],
    ['review', 'omar', 'Ship it'],
    ['review-comment', 'priya', 'Done.'],
  ]);
  expect(found.entries.at(-1)).toMatchObject({ path: 'src/retry.ts', line: 42 });
  expect(found.checks).toEqual([
    { name: 'test', state: 'failure', url: 'https://ci.acme.test/runs/1' },
    { name: 'lint', state: 'pending', url: null },
  ]);
  expect(github.apiRequests.at(-1)).toBe('POST /graphql CommanderDiscussion');
  // A new comment moves the pull request's updated time, as on GitHub.
  expect(Date.parse(github.pullRequest('acme-org/api', 12)?.updatedAt ?? '')).toBeGreaterThanOrEqual(before);
});

it('answers an issue’s comments, and nothing for a node it doesn’t have', async () => {
  github.addComment('acme-org/api', 30, { author: 'sam', body: 'Seen it too.' });
  const found = await readGitHubDiscussion(
    { apiUrl: github.apiUrl, token: { token, kind: 'oauth' } },
    { kind: 'github-issue', nodeId: 'I_fake_acme-org_api_30' },
  );
  expect(found.entries.map((entry) => entry.body)).toEqual(['Seen it too.']);
  expect(found.checks).toBeNull();

  await expect(
    readGitHubDiscussion(
      { apiUrl: github.apiUrl, token: { token, kind: 'oauth' } },
      { kind: 'pull-request', nodeId: 'PR_nope' },
    ),
  ).rejects.toThrow('GitHub no longer shows this pull request.');
});
