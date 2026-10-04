import { describe, expect, it } from 'vitest';
import { type AccessToken, SignInRefused } from '../source';
import recordedAnswers from './recorded/writer-detail.json';
import { readGitHubWriterDetails } from './writer-detail';

// What the oversight summary's writer reads about each pull request (#119), fetched in batches with
// GraphQL against recorded answers: the description, linked issues, reviews and review comments, the
// first 30 discussion comments, and the change outline by area. Never the diff.

type Recorded = { status: number; headers: Record<string, string>; body: unknown };
const recorded = recordedAnswers as unknown as Record<string, Recorded>;

const API = 'https://api.github.test';
const token: AccessToken = { token: 'ghu_writer', kind: 'oauth' };

type Sent = {
  url: string;
  authorization: string | null;
  operationName: string;
  variables: { ids: string[] };
};

function answering(...answers: Recorded[]) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { operationName: string; variables: { ids: string[] } };
    sent.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      operationName: request.operationName,
      variables: request.variables,
    });
    const answer = answers[Math.min(sent.length - 1, answers.length - 1)] as Recorded;
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: answer.headers });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const batch = recorded.batch as Recorded;

describe('readGitHubWriterDetails', () => {
  it('reads each pull request’s description, linked issues, reviews, comments and change outline', async () => {
    const { fetch, sent } = answering(batch);
    const found = await readGitHubWriterDetails({ apiUrl: API, token, fetch }, [
      'PR_kwDOAcme12',
      'PR_gone',
      'PR_kwDOAcme9',
    ]);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      url: `${API}/graphql`,
      authorization: 'Bearer ghu_writer',
      operationName: 'CommanderWriterDetail',
      variables: { ids: ['PR_kwDOAcme12', 'PR_gone', 'PR_kwDOAcme9'], comments: 30, files: 100 },
    });

    const detail = found.get('PR_kwDOAcme12');
    expect(detail?.description).toBe(
      'Retries failed webhook deliveries with exponential back-off.\n\nCloses #30. Fixes ENG-412.',
    );
    expect(detail?.linkedIssues).toEqual([
      {
        owner: 'acme',
        name: 'api',
        number: 30,
        title: 'Webhooks drop on 502',
        body: 'Deliveries that get a 502 are never retried.',
      },
    ]);
    // A draft review is the reviewer's own, and an empty "commented" one only holds line comments.
    expect(detail?.reviews).toEqual([
      {
        author: 'omar',
        state: 'changes-requested',
        body: 'Cap the retries, please.',
        at: Date.parse('2026-10-02T10:00:00Z'),
      },
      { author: 'omar', state: 'approved', body: '', at: Date.parse('2026-10-03T12:00:00Z') },
    ]);
    expect(detail?.reviewComments).toEqual([
      {
        author: 'omar',
        body: 'Why 7 attempts?',
        at: Date.parse('2026-10-02T11:00:00Z'),
        path: 'apps/core/src/webhooks/retry.ts',
      },
      {
        author: 'priya',
        body: "GitHub's own retry count.",
        at: Date.parse('2026-10-02T12:00:00Z'),
        path: 'apps/core/src/webhooks/retry.ts',
      },
    ]);
    expect(detail?.comments).toHaveLength(30);
    expect(detail?.comments[0]).toEqual({
      author: 'omar',
      body: 'Comment 1',
      at: Date.parse('2026-10-01T00:00:00Z'),
    });
    expect(detail?.moreComments).toBe(true);
    expect(detail?.changeOutline).toEqual({
      areas: [
        { area: 'apps/core', files: 2, additions: 200, deletions: 4 },
        { area: 'packages/ui', files: 1, additions: 6, deletions: 2 },
      ],
      files: 3,
      totalFiles: 3,
    });

    // GitHub no longer has one: it is left out, and the rest still come.
    expect(found.has('PR_gone')).toBe(false);
    expect(found.get('PR_kwDOAcme9')).toEqual({
      description: '',
      linkedIssues: [],
      reviews: [],
      reviewComments: [],
      comments: [],
      moreComments: false,
      changeOutline: { areas: [], files: 0, totalFiles: 0 },
    });
  });

  it('asks about at most 25 pull requests a query', async () => {
    const { fetch, sent } = answering(batch);
    const ids = Array.from({ length: 30 }, (_, i) => `PR_${i}`);
    await readGitHubWriterDetails({ apiUrl: API, token, fetch }, ids);
    expect(sent.map((each) => each.variables.ids.length)).toEqual([25, 5]);
    expect(sent.flatMap((each) => each.variables.ids)).toEqual(ids);
  });

  it('asks nothing when there is nothing to ask about', async () => {
    const { fetch, sent } = answering(batch);
    expect((await readGitHubWriterDetails({ apiUrl: API, token, fetch }, [])).size).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('says when GitHub refuses the sign-in', async () => {
    const { fetch } = answering(recorded.unauthorised as Recorded);
    await expect(
      readGitHubWriterDetails({ apiUrl: API, token, fetch }, ['PR_kwDOAcme12']),
    ).rejects.toBeInstanceOf(SignInRefused);
  });
});
