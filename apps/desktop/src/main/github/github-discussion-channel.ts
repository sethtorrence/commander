// The GitHub Section's discussions (#115), in the main process: relays the window's requests to the
// Core, adding where GitHub's API lives (a fake on this machine in tests), and its answers back. Both
// directions are checked. The Core borrows the Account's token itself, so nothing secret passes here.
import {
  type CoreGitHubDiscussionRequest,
  coreGitHubDiscussionReply,
  type GitHubDiscussionResponse,
  githubDiscussionRequest,
} from '@commander/domain';
import { z } from 'zod';

// One GraphQL query, which GitHub answers within its own 10-second limit (a token refresh may come first).
const TIMEOUT_MS = 60_000;

const replyHeader = z.object({ type: z.literal('github-discussion-reply'), id: z.number().int().positive() });

export function createGitHubDiscussionChannel({
  apiUrl,
  send,
}: {
  apiUrl: string;
  send: (message: CoreGitHubDiscussionRequest) => void;
}) {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (response: GitHubDiscussionResponse) => void; timer: NodeJS.Timeout }
  >();

  return {
    // A request from the window.
    request(raw: unknown): Promise<GitHubDiscussionResponse> {
      const parsed = githubDiscussionRequest.safeParse(raw);
      if (!parsed.success) {
        const said = parsed.error.issues[0]?.message ?? parsed.error.message;
        return Promise.resolve({ ok: false, error: `Rejected discussion request: ${said}` });
      }
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, error: 'The Core did not answer in time' });
        }, TIMEOUT_MS);
        pending.set(id, { resolve, timer });
        send({ type: 'github-discussion-request', id, apiUrl, request: parsed.data });
      });
    },

    // A message from the Core. Returns true when it was a discussion reply, handled here.
    settle(raw: unknown): boolean {
      const header = replyHeader.safeParse(raw);
      if (!header.success) return false;
      const waiting = pending.get(header.data.id);
      if (!waiting) return true;
      pending.delete(header.data.id);
      clearTimeout(waiting.timer);
      const parsed = coreGitHubDiscussionReply.safeParse(raw);
      waiting.resolve(
        parsed.success
          ? parsed.data.response
          : { ok: false, error: `Rejected a malformed discussion reply: ${parsed.error.message}` },
      );
      return true;
    },
  };
}
