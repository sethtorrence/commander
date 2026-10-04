import { z } from 'zod';
import { SignInError } from '../oauth/sign-in-error';

// The few REST calls signing in needs: who a token signs in as (and, for classic and OAuth tokens,
// its scopes, from X-OAuth-Scopes), and where Commander's GitHub App is installed. Every token goes as
// "Bearer <token>", with the User-Agent GitHub insists on. Errors never carry the token.

export type GitHubUser = { id: number; login: string; name: string | null };

const API_VERSION = '2022-11-28';

export function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': API_VERSION,
    'user-agent': 'Commander',
  };
}

const userResponse = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  name: z.string().nullable(),
});

const installationsResponse = z.object({
  total_count: z.number().int().nonnegative(),
  installations: z.array(z.object({ account: z.object({ login: z.string().min(1) }).nullable() })),
});

const unreachable = () =>
  new SignInError('unreachable', 'Commander couldn’t reach GitHub. Check your connection and try again.');

async function get(url: string, token: string): Promise<Response> {
  try {
    return await fetch(url, { headers: githubHeaders(token) });
  } catch {
    throw unreachable();
  }
}

// Who the token signs in as, and its scopes (null when GitHub lists none: GitHub App and
// fine-grained tokens). `refused` explains a token GitHub doesn't accept.
export async function readUser(
  apiUrl: string,
  token: string,
  refused: string,
): Promise<{ user: GitHubUser; scopes: string[] | null }> {
  const response = await get(`${apiUrl}/user`, token);
  const parsed = userResponse.safeParse(await response.json().catch(() => null));
  if (response.ok && parsed.success) {
    const header = response.headers.get('x-oauth-scopes');
    const scopes =
      header === null
        ? null
        : header
            .split(',')
            .map((scope) => scope.trim())
            .filter(Boolean);
    return { user: parsed.data, scopes };
  }
  if (response.status === 401 || response.status === 403)
    throw new SignInError('invalid-credential', refused);
  throw new SignInError(
    'unreachable',
    `GitHub couldn’t answer just now (HTTP ${response.status}). Try again.`,
  );
}

const PER_PAGE = 100;
// Enough for any one User; a stop in case GitHub keeps answering.
const MAX_PAGES = 20;

// The user and organisation logins Commander's GitHub App is installed on, that this User can see.
// Only a GitHub App user token can ask.
export async function readInstallations(apiUrl: string, accessToken: string): Promise<string[]> {
  const logins: string[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await get(`${apiUrl}/user/installations?per_page=${PER_PAGE}&page=${page}`, accessToken);
    const parsed = installationsResponse.safeParse(await response.json().catch(() => null));
    if (!response.ok || !parsed.success) {
      throw new SignInError(
        'unreachable',
        `GitHub couldn’t say where Commander’s GitHub App is installed (HTTP ${response.status}). Try again.`,
      );
    }
    const { installations, total_count } = parsed.data;
    for (const { account } of installations) if (account) logins.push(account.login);
    if (installations.length < PER_PAGE || page * PER_PAGE >= total_count) break;
  }
  return logins;
}
