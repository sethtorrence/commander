import {
  changeOutline,
  GITHUB_WRITER_BATCH,
  GITHUB_WRITER_COMMENTS,
  GITHUB_WRITER_FILES,
  type GitHubWriterDetail,
} from '@commander/domain';
import { z } from 'zod';
import type { GitHubApiOptions } from './access';
import { connectGitHub, RATE_LIMIT_FIELDS } from './client';

/*
  What the oversight summary's writer reads about each pull request in a summary (#119), asked of
  GitHub in batches of GITHUB_WRITER_BATCH pull requests per GraphQL query (by node id): the
  description, the issues it closes (titles and bodies), its reviews and review comments, its first
  GITHUB_WRITER_COMMENTS conversation comments, and its first GITHUB_WRITER_FILES files' paths and
  line counts for the change outline. Never the diff. A pull request GitHub no longer has is left out.
  Errors are the Source errors (client.ts): a refused sign-in is SignInRefused, a limit RateLimited.
*/

const AUTHOR = 'author { login }';

export const WRITER_DETAIL = `query CommanderWriterDetail($ids: [ID!]!, $comments: Int!, $files: Int!) {
  nodes(ids: $ids) {
    __typename
    ... on PullRequest {
      id
      body
      closingIssuesReferences(first: 10) { nodes { number title body repository { name owner { login } } } }
      reviews(first: 50) { nodes { ${AUTHOR} state body submittedAt createdAt } }
      reviewThreads(first: 50) { nodes { path comments(first: 20) { nodes { ${AUTHOR} body createdAt } } } }
      comments(first: $comments) { totalCount nodes { ${AUTHOR} body createdAt } }
      files(first: $files) { totalCount nodes { path additions deletions } }
    }
  }
  ${RATE_LIMIT_FIELDS}
}`;

const author = z
  .object({ login: z.string().min(1) })
  .nullable()
  .optional()
  .transform((value) => value?.login ?? null);
const text = z
  .string()
  .nullable()
  .optional()
  .transform((value) => value ?? '');
const nodesOf = <T extends z.ZodType>(node: T) =>
  z
    .object({ nodes: z.array(node.nullable()).default([]) })
    .nullable()
    .optional()
    .transform((value) =>
      (value?.nodes ?? []).filter((each): each is NonNullable<z.infer<T>> => each != null),
    );

const comment = z.object({ author, body: text, createdAt: z.string() });

const pullRequest = z.object({
  __typename: z.literal('PullRequest'),
  id: z.string().min(1),
  body: text,
  closingIssuesReferences: nodesOf(
    z.object({
      number: z.number().int().positive(),
      title: z.string(),
      body: text,
      repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
    }),
  ),
  reviews: nodesOf(
    z.object({
      author,
      state: z.string(),
      body: text,
      submittedAt: z.string().nullable().optional(),
      createdAt: z.string(),
    }),
  ),
  reviewThreads: nodesOf(z.object({ path: z.string().nullable().optional(), comments: nodesOf(comment) })),
  comments: z
    .object({
      totalCount: z.number().int().nonnegative().default(0),
      nodes: z.array(comment.nullable()).default([]),
    })
    .nullable()
    .optional(),
  files: z
    .object({
      totalCount: z.number().int().nonnegative().default(0),
      nodes: z
        .array(
          z.object({ path: z.string(), additions: z.number().int(), deletions: z.number().int() }).nullable(),
        )
        .default([]),
    })
    .nullable()
    .optional(),
});

const answer = z.object({
  nodes: z.array(
    z.union([pullRequest, z.object({ __typename: z.string() }).transform(() => null)]).nullable(),
  ),
});

const REVIEW_STATES: Record<string, GitHubWriterDetail['reviews'][number]['state']> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
};

export type ReadWriterDetail = Omit<GitHubWriterDetail, 'forUpdatedAt' | 'fetchedAt'>;

const at = (time: string | null | undefined) => (time ? Date.parse(time) || 0 : 0);

function detailOf(pull: z.infer<typeof pullRequest>): ReadWriterDetail {
  const reviews = pull.reviews
    .flatMap((review) => {
      const state = REVIEW_STATES[review.state];
      // A draft review is the reviewer's own; an empty "commented" review only holds line comments.
      if (!state || (state === 'commented' && !review.body.trim())) return [];
      return [
        { author: review.author, state, body: review.body, at: at(review.submittedAt ?? review.createdAt) },
      ];
    })
    .sort((a, b) => a.at - b.at);
  const reviewComments = pull.reviewThreads
    .flatMap((thread) =>
      thread.comments.map((each) => ({
        author: each.author,
        body: each.body,
        at: at(each.createdAt),
        path: thread.path ?? null,
      })),
    )
    .sort((a, b) => a.at - b.at);
  const comments = (pull.comments?.nodes ?? [])
    .filter((each) => each !== null)
    .map((each) => ({ author: each.author, body: each.body, at: at(each.createdAt) }));
  const files = (pull.files?.nodes ?? []).filter((each) => each !== null);
  return {
    description: pull.body,
    linkedIssues: pull.closingIssuesReferences.map((issue) => ({
      owner: issue.repository.owner.login,
      name: issue.repository.name,
      number: issue.number,
      title: issue.title,
      body: issue.body,
    })),
    reviews,
    reviewComments,
    comments,
    moreComments: (pull.comments?.totalCount ?? 0) > comments.length,
    changeOutline: changeOutline(
      files.map((file) => ({
        path: file.path,
        additions: Math.max(0, file.additions),
        deletions: Math.max(0, file.deletions),
      })),
      pull.files?.totalCount ?? files.length,
    ),
  };
}

/** Asks GitHub what the summary's writer reads about these pull requests (by node id). */
export async function readGitHubWriterDetails(
  { apiUrl, token, fetch = globalThis.fetch, now = Date.now, signal }: GitHubApiOptions,
  nodeIds: readonly string[],
): Promise<Map<string, ReadWriterDetail>> {
  const found = new Map<string, ReadWriterDetail>();
  if (!nodeIds.length) return found;
  const client = connectGitHub({
    apiUrl,
    fetch,
    now,
    accessToken: async () => token,
    signal: signal ?? new AbortController().signal,
  });
  for (let start = 0; start < nodeIds.length; start += GITHUB_WRITER_BATCH) {
    const ids = nodeIds.slice(start, start + GITHUB_WRITER_BATCH);
    const data = await client.graphql(
      WRITER_DETAIL,
      'CommanderWriterDetail',
      { ids, comments: GITHUB_WRITER_COMMENTS, files: GITHUB_WRITER_FILES },
      answer,
      { allowNotFound: true },
    );
    for (const node of data.nodes) if (node) found.set(node.id, detailOf(node));
  }
  return found;
}
