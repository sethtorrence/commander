import {
  GITHUB_DISCUSSION_LATEST,
  type GitHubCheck,
  type GitHubDiscussion,
  type GitHubDiscussionEntry,
} from '@commander/domain';
import { z } from 'zod';
import { SourceUnavailable } from '../source';
import type { GitHubApiOptions } from './access';
import { connectGitHub, RATE_LIMIT_FIELDS } from './client';

/*
  A pull request's or issue's discussion, read on demand when the GitHub Section opens it (#115):
  GitHub sync never fetches comment threads, which would cost a query per pull request. One GraphQL
  query by node id brings the latest 50 conversation comments, and for a pull request the latest 50
  reviews and review threads (up to 20 comments each) and its head commit's checks. Errors are the
  Source errors (client.ts): a refused sign-in is SignInRefused, a limit RateLimited.
*/

const COMMENT = 'id url body createdAt author { login }';

export const DISCUSSION = `query CommanderDiscussion($id: ID!, $latest: Int!) {
  node(id: $id) {
    __typename
    ... on Issue {
      comments(last: $latest) { totalCount nodes { ${COMMENT} } }
    }
    ... on PullRequest {
      comments(last: $latest) { totalCount nodes { ${COMMENT} } }
      reviews(last: $latest) { totalCount nodes { ${COMMENT} state submittedAt } }
      reviewThreads(last: $latest) {
        totalCount
        nodes { path line originalLine comments(first: 20) { totalCount nodes { ${COMMENT} } } }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 50) {
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion detailsUrl }
                  ... on StatusContext { context state targetUrl }
                }
              }
            }
          }
        }
      }
    }
  }
  ${RATE_LIMIT_FIELDS}
}`;

const counted = <T extends z.ZodType>(node: T) =>
  z
    .object({
      totalCount: z.number().int().nonnegative().default(0),
      nodes: z.array(node.nullable()).default([]),
    })
    .nullable()
    .optional()
    .transform((value) => {
      const nodes = (value?.nodes ?? []).filter((each): each is NonNullable<z.infer<T>> => each != null);
      return { nodes, more: (value?.totalCount ?? 0) > nodes.length };
    });

const comment = z.object({
  id: z.string().min(1),
  url: z.string().default(''),
  body: z.string().nullable().default(''),
  createdAt: z.string().min(1),
  author: z
    .object({ login: z.string().min(1) })
    .nullable()
    .optional()
    .default(null),
});

const review = comment.extend({ state: z.string(), submittedAt: z.string().nullable().optional() });

const thread = z.object({
  path: z.string().nullable().optional().default(null),
  line: z.number().int().positive().nullable().optional().default(null),
  originalLine: z.number().int().positive().nullable().optional().default(null),
  comments: counted(comment),
});

const context = z.union([
  z.object({
    __typename: z.literal('CheckRun'),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable().optional(),
    detailsUrl: z.string().nullable().optional(),
  }),
  z.object({
    __typename: z.literal('StatusContext'),
    context: z.string(),
    state: z.string(),
    targetUrl: z.string().nullable().optional(),
  }),
  // Anything GitHub adds later is left out.
  z.object({ __typename: z.string() }).transform(() => null),
]);

const discussionData = z.object({
  node: z
    .object({
      __typename: z.string(),
      comments: counted(comment),
      reviews: counted(review),
      reviewThreads: counted(thread),
      commits: z
        .object({
          nodes: z
            .array(
              z
                .object({
                  commit: z.object({
                    statusCheckRollup: z
                      .object({ contexts: z.object({ nodes: z.array(context.nullable()).default([]) }) })
                      .nullable()
                      .optional(),
                  }),
                })
                .nullable(),
            )
            .default([]),
        })
        .nullable()
        .optional(),
    })
    .nullable(),
});

const REVIEW_STATES: Record<string, NonNullable<GitHubDiscussionEntry['state']>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending',
};

const CONCLUSIONS: Record<string, GitHubCheck['state']> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  STARTUP_FAILURE: 'failure',
  NEUTRAL: 'neutral',
  SKIPPED: 'skipped',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed-out',
  ACTION_REQUIRED: 'action-required',
  STALE: 'stale',
};
const STATUS_STATES: Record<string, GitHubCheck['state']> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  ERROR: 'error',
  PENDING: 'pending',
  EXPECTED: 'pending',
};

type Comment = z.infer<typeof comment>;

const entryOf = (
  kind: GitHubDiscussionEntry['kind'],
  each: Comment,
  extra: Partial<GitHubDiscussionEntry> = {},
): GitHubDiscussionEntry => ({
  id: each.id,
  kind,
  author: each.author?.login ?? null,
  body: each.body ?? '',
  at: Date.parse(each.createdAt) || 0,
  url: each.url,
  state: null,
  path: null,
  line: null,
  ...extra,
});

export type DiscussionTarget = { kind: 'pull-request' | 'github-issue'; nodeId: string };
export type ReadDiscussion = Omit<GitHubDiscussion, 'forUpdatedAt' | 'fetchedAt'>;

/** Asks GitHub for a pull request's or issue's discussion (and a pull request's checks). */
export async function readGitHubDiscussion(
  { apiUrl, token, fetch = globalThis.fetch, now = Date.now, signal }: GitHubApiOptions,
  target: DiscussionTarget,
): Promise<ReadDiscussion> {
  const client = connectGitHub({
    apiUrl,
    fetch,
    now,
    accessToken: async () => token,
    signal: signal ?? new AbortController().signal,
  });
  const data = await client.graphql(
    DISCUSSION,
    'CommanderDiscussion',
    { id: target.nodeId, latest: GITHUB_DISCUSSION_LATEST },
    discussionData,
    { allowNotFound: true },
  );
  const node = data.node;
  const pull = target.kind === 'pull-request';
  if (!node || node.__typename !== (pull ? 'PullRequest' : 'Issue'))
    throw new SourceUnavailable(`GitHub no longer shows this ${pull ? 'pull request' : 'issue'}.`);

  const entries: GitHubDiscussionEntry[] = node.comments.nodes.map((each) => entryOf('comment', each));
  let more = node.comments.more;
  if (pull) {
    for (const each of node.reviews.nodes) {
      const state = REVIEW_STATES[each.state] ?? 'commented';
      // A draft review is the reviewer's own until submitted; an empty "commented" review only holds
      // its review comments, which come with their threads.
      if (state === 'pending' || (state === 'commented' && !each.body?.trim())) continue;
      entries.push(entryOf('review', { ...each, createdAt: each.submittedAt ?? each.createdAt }, { state }));
    }
    for (const { path, line, originalLine, comments } of node.reviewThreads.nodes) {
      for (const each of comments.nodes)
        entries.push(entryOf('review-comment', each, { path, line: line ?? originalLine }));
      more ||= comments.more;
    }
    more ||= node.reviews.more || node.reviewThreads.more;
  }
  entries.sort((a, b) => a.at - b.at);

  const contexts = pull ? (node.commits?.nodes.at(-1)?.commit.statusCheckRollup?.contexts.nodes ?? []) : [];
  const checks: GitHubCheck[] | null = pull
    ? contexts.flatMap((each): GitHubCheck[] => {
        if (!each) return [];
        if (each.__typename === 'CheckRun') {
          const done = each.status === 'COMPLETED';
          const state = done ? (CONCLUSIONS[each.conclusion ?? ''] ?? 'neutral') : 'pending';
          return [{ name: each.name, state, url: each.detailsUrl ?? null }];
        }
        return [
          { name: each.context, state: STATUS_STATES[each.state] ?? 'pending', url: each.targetUrl ?? null },
        ];
      })
    : null;
  return { entries, more, checks };
}
