// Settings → GitHub (#113), in the main process: relays the window's requests to the Core, adding
// where GitHub's API lives (a fake on this machine in tests), and its answers back. Both directions
// are checked. The Core borrows the Account's token itself, through the Accounts' token requests, so
// nothing secret passes here.
import {
  type CoreGitHubWatchRequest,
  coreGitHubWatchReply,
  type GitHubWatchResponse,
  githubWatchRequest,
} from '@commander/domain';
import { z } from 'zod';

// Listing a large Account (many orgs, each with hundreds of repos) takes GitHub a while.
const TIMEOUT_MS = 2 * 60_000;

const replyHeader = z.object({ type: z.literal('github-watch-reply'), id: z.number().int().positive() });

export function createGitHubWatchChannel({
  apiUrl,
  send,
}: {
  apiUrl: string;
  send: (message: CoreGitHubWatchRequest) => void;
}) {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (response: GitHubWatchResponse) => void; timer: NodeJS.Timeout }
  >();

  return {
    // A request from the window.
    request(raw: unknown): Promise<GitHubWatchResponse> {
      const parsed = githubWatchRequest.safeParse(raw);
      if (!parsed.success) {
        const said = parsed.error.issues[0]?.message ?? parsed.error.message;
        return Promise.resolve({
          ok: false,
          error: `Rejected Settings → GitHub request: ${said}`,
          view: null,
        });
      }
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, error: 'The Core did not answer in time', view: null });
        }, TIMEOUT_MS);
        pending.set(id, { resolve, timer });
        send({ type: 'github-watch-request', id, apiUrl, request: parsed.data });
      });
    },

    // A message from the Core. Returns true when it was a Settings → GitHub reply, handled here.
    settle(raw: unknown): boolean {
      const header = replyHeader.safeParse(raw);
      if (!header.success) return false;
      const waiting = pending.get(header.data.id);
      if (!waiting) return true;
      pending.delete(header.data.id);
      clearTimeout(waiting.timer);
      const parsed = coreGitHubWatchReply.safeParse(raw);
      waiting.resolve(
        parsed.success
          ? parsed.data.response
          : {
              ok: false,
              error: `Rejected a malformed Settings → GitHub reply: ${parsed.error.message}`,
              view: null,
            },
      );
      return true;
    },
  };
}
