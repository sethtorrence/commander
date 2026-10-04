import { describe, expect, it } from 'vitest';
import { type AccessToken, RateLimited, SignInRefused, SourceUnavailable } from '../source';
import { readGitHubDiscussion } from './discussion';

// A pull request's or issue's discussion, read on demand with one GraphQL query (#115), against
// answers shaped as GitHub gives them.

const API = 'https://api.github.test';
const token: AccessToken = { token: 'ghu_discussion', kind: 'oauth' };
const RATE = { cost: 3, limit: 5000, remaining: 4990, resetAt: '2026-10-03T13:00:00Z' };

type Sent = { url: string; authorization: string | null; operationName: string; variables: unknown };

function answering(status: number, body: unknown, headers: Record<string, string> = {}) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { operationName: string; variables: unknown };
    sent.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      operationName: request.operationName,
      variables: request.variables,
    });
    return new Response(JSON.stringify(body), { status, headers });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const author = (login: string) => ({ login });

const PULL_ANSWER = {
  data: {
    node: {
      __typename: 'PullRequest',
      comments: {
        totalCount: 2,
        nodes: [
          {
            id: 'IC_1',
            url: 'https://github.test/acme/api/pull/12#issuecomment-1',
            body: 'Looks close. Can we keep the old flag?',
            createdAt: '2026-10-01T09:00:00Z',
            author: author('omar'),
          },
          {
            id: 'IC_2',
            url: 'https://github.test/acme/api/pull/12#issuecomment-2',
            body: 'Done.',
            createdAt: '2026-10-02T10:00:00Z',
            author: null,
          },
        ],
      },
      reviews: {
        totalCount: 3,
        nodes: [
          {
            id: 'PRR_1',
            url: 'https://github.test/acme/api/pull/12#pullrequestreview-1',
            body: '',
            state: 'COMMENTED',
            createdAt: '2026-10-01T11:00:00Z',
            submittedAt: '2026-10-01T11:00:00Z',
            author: author('omar'),
          },
          {
            id: 'PRR_2',
            url: 'https://github.test/acme/api/pull/12#pullrequestreview-2',
            body: '',
            state: 'APPROVED',
            createdAt: '2026-10-02T12:00:00Z',
            submittedAt: '2026-10-02T12:00:00Z',
            author: author('omar'),
          },
          {
            id: 'PRR_3',
            url: 'https://github.test/acme/api/pull/12#pullrequestreview-3',
            body: 'Drafting',
            state: 'PENDING',
            createdAt: '2026-10-02T13:00:00Z',
            submittedAt: null,
            author: author('octocat'),
          },
        ],
      },
      reviewThreads: {
        totalCount: 1,
        nodes: [
          {
            path: 'src/retry.ts',
            line: 42,
            originalLine: 40,
            comments: {
              totalCount: 1,
              nodes: [
                {
                  id: 'PRRC_1',
                  url: 'https://github.test/acme/api/pull/12#discussion_r1',
                  body: 'Off by one?',
                  createdAt: '2026-10-01T11:00:00Z',
                  author: author('omar'),
                },
              ],
            },
          },
        ],
      },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      __typename: 'CheckRun',
                      name: 'test',
                      status: 'COMPLETED',
                      conclusion: 'FAILURE',
                      detailsUrl: 'https://github.test/acme/api/actions/runs/1',
                    },
                    {
                      __typename: 'CheckRun',
                      name: 'lint',
                      status: 'IN_PROGRESS',
                      conclusion: null,
                      detailsUrl: null,
                    },
                    {
                      __typename: 'StatusContext',
                      context: 'ci/deploy-preview',
                      state: 'SUCCESS',
                      targetUrl: 'https://preview.acme.test/12',
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
    rateLimit: RATE,
  },
};

describe('reading a discussion from GitHub', () => {
  it('asks for one pull request by node id, with the token, in one GraphQL query', async () => {
    const github = answering(200, PULL_ANSWER);
    await readGitHubDiscussion(
      { apiUrl: API, token, fetch: github.fetch },
      { kind: 'pull-request', nodeId: 'PR_12' },
    );
    expect(github.sent).toEqual([
      {
        url: `${API}/graphql`,
        authorization: 'Bearer ghu_discussion',
        operationName: 'CommanderDiscussion',
        variables: { id: 'PR_12', latest: 50 },
      },
    ]);
  });

  it('gives comments, reviews with a body or a verdict, and review comments, oldest first', async () => {
    const github = answering(200, PULL_ANSWER);
    const found = await readGitHubDiscussion(
      { apiUrl: API, token, fetch: github.fetch },
      { kind: 'pull-request', nodeId: 'PR_12' },
    );
    expect(found.entries.map((entry) => [entry.kind, entry.id, entry.author, entry.state])).toEqual([
      ['comment', 'IC_1', 'omar', null],
      ['review-comment', 'PRRC_1', 'omar', null],
      ['comment', 'IC_2', null, null],
      ['review', 'PRR_2', 'omar', 'approved'],
    ]);
    const onLine = found.entries.find((entry) => entry.id === 'PRRC_1');
    expect(onLine).toMatchObject({ path: 'src/retry.ts', line: 42, body: 'Off by one?' });
    expect(found.entries[0]).toMatchObject({
      body: 'Looks close. Can we keep the old flag?',
      at: Date.parse('2026-10-01T09:00:00Z'),
      url: 'https://github.test/acme/api/pull/12#issuecomment-1',
    });
    // Three reviews on GitHub, two shown, but nothing older was left out.
    expect(found.more).toBe(false);
  });

  it('gives each check on the head commit with its state and page', async () => {
    const github = answering(200, PULL_ANSWER);
    const found = await readGitHubDiscussion(
      { apiUrl: API, token, fetch: github.fetch },
      { kind: 'pull-request', nodeId: 'PR_12' },
    );
    expect(found.checks).toEqual([
      { name: 'test', state: 'failure', url: 'https://github.test/acme/api/actions/runs/1' },
      { name: 'lint', state: 'pending', url: null },
      { name: 'ci/deploy-preview', state: 'success', url: 'https://preview.acme.test/12' },
    ]);
  });

  it('reads an issue’s comments, with no checks, and says when older ones were left out', async () => {
    const github = answering(200, {
      data: {
        node: {
          __typename: 'Issue',
          comments: {
            totalCount: 73,
            nodes: [
              {
                id: 'IC_9',
                url: 'https://github.test/acme/api/issues/30#issuecomment-9',
                body: 'Still happening.',
                createdAt: '2026-10-02T08:00:00Z',
                author: author('priya'),
              },
            ],
          },
        },
        rateLimit: RATE,
      },
    });
    const found = await readGitHubDiscussion(
      { apiUrl: API, token, fetch: github.fetch },
      { kind: 'github-issue', nodeId: 'I_30' },
    );
    expect(github.sent[0]?.variables).toEqual({ id: 'I_30', latest: 50 });
    expect(found.entries.map((entry) => entry.id)).toEqual(['IC_9']);
    expect(found.checks).toBeNull();
    expect(found.more).toBe(true);
  });

  it('says so when GitHub no longer shows the pull request', async () => {
    const github = answering(200, {
      data: { node: null, rateLimit: RATE },
      errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a node' }],
    });
    await expect(
      readGitHubDiscussion(
        { apiUrl: API, token, fetch: github.fetch },
        { kind: 'pull-request', nodeId: 'PR_gone' },
      ),
    ).rejects.toThrow(new SourceUnavailable('GitHub no longer shows this pull request.'));
  });

  it('turns a refused sign-in and a rate limit into the Source errors', async () => {
    const refused = answering(401, { message: 'Bad credentials' });
    await expect(
      readGitHubDiscussion(
        { apiUrl: API, token, fetch: refused.fetch },
        { kind: 'pull-request', nodeId: 'PR_12' },
      ),
    ).rejects.toBeInstanceOf(SignInRefused);

    const limited = answering(429, { message: 'slow down' }, { 'retry-after': '30' });
    await expect(
      readGitHubDiscussion(
        { apiUrl: API, token, fetch: limited.fetch },
        { kind: 'pull-request', nodeId: 'PR_12' },
      ),
    ).rejects.toBeInstanceOf(RateLimited);
  });
});
