import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in for GitHub, for tests only (unit and end-to-end). It behaves like GitHub where
// Commander depends on it: a GitHub App's device flow (no client secret; the token endpoint answers
// its errors with HTTP 200, as GitHub does; `slow_down` raising the interval), 8-hour user tokens
// with rotating refresh tokens, classic personal access tokens and gh's OAuth token with their
// scopes in X-OAuth-Scopes, `GET /user`, `GET /user/installations` (GitHub App tokens only), orgs and
// repos (what Settings → GitHub lists, #113), and what GitHub sync reads (#114): the gates (org repos
// and issues, the User's repos and teams, a repo's issues) answering If-None-Match with a free 304,
// X-RateLimit headers, and the GraphQL GitHub sync sends (open work, search, repos, the sweep) over
// pull requests, issues, releases and commits added here. It also answers the GitHub Section's
// discussion query (#115): comments, reviews, review comments and a pull request's checks. It can
// also refuse with a rate limit (403 or 429, with Retry-After). Nothing here talks to the real GitHub.
//
// What a GitHub App's user token may see of orgs without an install is untested against GitHub: here
// /user/memberships/orgs and /user/orgs refuse it ("Resource not accessible by integration"), the
// most cautious reading, while anyone may read a user's public memberships.

export type FakeGitHubUser = { id: number; login: string; name: string | null };

// A token GitHub issued, and what kind: a GitHub App user token (ghu_), a classic personal access
// token (ghp_), gh's OAuth token (gho_) or a fine-grained token (github_pat_).
type TokenKind = 'app' | 'classic' | 'oauth' | 'fine-grained';
type Grant = { user: FakeGitHubUser; accessToken: string; refreshToken: string | null; kind: TokenKind };
type Personal = { user: FakeGitHubUser; kind: TokenKind; scopes: string[] };

type DeviceCode = {
  deviceCode: string;
  userCode: string;
  // Who entered the code on github.com and approved, or declined it.
  answer: FakeGitHubUser | 'denied' | null;
  expired: boolean;
};

// Where Commander's GitHub App is installed: on all of the account's repos, or the named ones.
export type FakeGitHubInstallation = {
  login: string;
  type: 'User' | 'Organization';
  repositories?: string[];
};

// An organization: its members, and those who show their membership publicly.
export type FakeGitHubOrg = { login: string; id: number; members: number[]; publicMembers?: number[] };

// A repository, owned by a user or an org (by login). Members of its org, its owner and its
// collaborators can reach it.
export type FakeGitHubRepo = {
  owner: string;
  name: string;
  private?: boolean;
  archived?: boolean;
  // ISO time of the last push; null for an empty repo.
  pushedAt?: string | null;
  collaborators?: number[];
};

// A comment on a pull request or issue, by a user (login); with a `path` (and line), a review
// comment on a line of a pull request's code. Times are ISO strings.
export type FakeGitHubComment = {
  author: string;
  body: string;
  createdAt?: string;
  path?: string;
  line?: number;
};

// A submitted review of a pull request.
export type FakeGitHubReview = {
  author: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  body?: string;
  submittedAt?: string;
};

// A check run on a pull request's head commit: its conclusion once done, null while it runs.
export type FakeGitHubCheckRun = {
  name: string;
  conclusion: 'SUCCESS' | 'FAILURE' | 'NEUTRAL' | 'SKIPPED' | 'CANCELLED' | null;
  url?: string;
};

// A pull request: in a repo ("owner/name"), by a user (login). `reviewers` and `teams` ("org/slug")
// are asked to review it. Times are ISO strings.
export type FakeGitHubPullRequest = {
  repo: string;
  number: number;
  title: string;
  body?: string;
  author: string;
  // The author's public email and profile name, when GitHub shows them (Person matching uses them).
  authorEmail?: string;
  authorName?: string;
  state?: 'OPEN' | 'CLOSED' | 'MERGED';
  draft?: boolean;
  reviewers?: string[];
  teams?: string[];
  assignees?: string[];
  labels?: string[];
  checks?: 'SUCCESS' | 'FAILURE' | 'PENDING' | null;
  // Its head commit's check runs (their rollup stands for `checks`), for the discussion query.
  checkRuns?: FakeGitHubCheckRun[];
  reviews?: FakeGitHubReview[];
  comments?: FakeGitHubComment[];
  // Issues in the same repo it closes when merged, by number.
  closes?: number[];
  createdAt?: string;
  updatedAt?: string;
};

export type FakeGitHubIssue = {
  repo: string;
  number: number;
  title: string;
  body?: string;
  author: string;
  state?: 'OPEN' | 'CLOSED';
  assignees?: string[];
  labels?: string[];
  comments?: FakeGitHubComment[];
  createdAt?: string;
  updatedAt?: string;
};

export type FakeGitHubRelease = {
  repo: string;
  tag: string;
  name?: string;
  notes?: string;
  publishedAt: string;
};

// A commit on a repo's default branch, newest last.
export type FakeGitHubCommit = { repo: string; message: string; author: string; committedAt: string };

// A team: its org, slug and members (user ids).
export type FakeGitHubTeam = { org: string; slug: string; members: number[] };

export type FakeGitHubOptions = {
  clientId?: string;
  appSlug?: string;
  // Seconds between polls the device flow asks for (GitHub says 5).
  interval?: number;
  // Seconds a device code lasts (GitHub: 900).
  codeExpiresIn?: number;
  // Seconds a user token lasts (GitHub: 28800), or null for an app with expiring tokens switched off.
  tokenExpiresIn?: number | null;
  // The app has "Enable Device Flow" ticked.
  deviceFlow?: boolean;
  // Overrides the verification URI the device flow sends the User to.
  verificationUri?: string;
};

export type FakeGitHub = {
  // Like https://github.com.
  webUrl: string;
  // Like https://api.github.com.
  apiUrl: string;
  clientId: string;
  appSlug: string;
  // Every device code request, as its form fields.
  deviceCodeRequests: Record<string, string>[];
  // Every token request (polls and refreshes), as its form fields.
  tokenRequests: Record<string, string>[];
  // Every API request, as its method and path ("GET /user"); GraphQL requests with their operation
  // ("POST /graphql CommanderOpenWork"), and 304s marked ("GET /user/teams 304").
  apiRequests: string[];
  // How many refreshes GitHub accepted.
  refreshes: number;
  // The device codes handed out, newest last (the User code only: what Commander shows).
  userCodes(): string[];
  // The User types the code at github.com/login/device and approves (as `user`). False when no such
  // code is waiting.
  enterCode(userCode: string, user?: FakeGitHubUser): boolean;
  // The User declines the newest code.
  deny(): void;
  // The newest code runs out.
  expire(): void;
  // The next `polls` token polls answer slow_down.
  slowDown(polls: number): void;
  // A classic personal access token (or gh's OAuth token, or a fine-grained one) for `user`.
  personalToken(options: {
    user?: FakeGitHubUser;
    kind: 'classic' | 'oauth' | 'fine-grained';
    scopes?: string[];
  }): string;
  // Where Commander's GitHub App is installed.
  install(installation: FakeGitHubInstallation): void;
  // Commander's GitHub App is uninstalled from an account.
  uninstall(login: string): void;
  addOrg(org: FakeGitHubOrg): void;
  // Returns the repo's node id.
  addRepo(repo: FakeGitHubRepo): string;
  // The user pushed to, opened a pull request in or reviewed in a repo ("owner/name") lately.
  contribute(userId: number, repo: string, kind?: 'commit' | 'pull-request' | 'review'): void;
  // What GitHub sync reads: pull requests, issues, releases, default-branch commits and teams.
  addPullRequest(pull: FakeGitHubPullRequest): void;
  // Changes a pull request (and its updatedAt, to now unless given).
  updatePullRequest(repo: string, number: number, changes: Partial<FakeGitHubPullRequest>): void;
  addIssue(issue: FakeGitHubIssue): void;
  // Comments on a pull request or issue (by number), moving its updatedAt to now, as GitHub does.
  addComment(repo: string, number: number, comment: FakeGitHubComment): void;
  // The pull request as it stands here.
  pullRequest(repo: string, number: number): FakeGitHubPullRequest | undefined;
  addRelease(release: FakeGitHubRelease): void;
  addCommit(commit: FakeGitHubCommit): void;
  addTeam(team: FakeGitHubTeam): void;
  // Every API request answers with this rate limit until switched off (null): a 403 or 429, with
  // Retry-After in seconds when given.
  throttleApi(limit: { status: 403 | 429; retryAfter?: number } | null): void;
  // Revokes every token of a user: refreshes with theirs now fail for good, and the API refuses them.
  revoke(userId: number): void;
  // Refreshes answer 503 until switched back.
  failRefreshesTemporarily(failing: boolean): void;
  // Holds each refresh this long before answering, to expose overlapping refreshes.
  delayRefreshes(ms: number): void;
  // Every token GitHub issued, and every device code (for asserting what reached disk, logs or the
  // window).
  secrets(): string[];
  close(): Promise<void>;
};

export const OCTOCAT: FakeGitHubUser = { id: 583231, login: 'octocat', name: 'The Octocat' };

const randomToken = (prefix: string) => `${prefix}_${randomBytes(18).toString('hex')}`;
const PREFIX: Record<TokenKind, string> = {
  app: 'ghu',
  classic: 'ghp',
  oauth: 'gho',
  'fine-grained': 'github_pat',
};

// GitHub's user codes: eight letters and digits, as XXXX-XXXX.
function userCode(): string {
  const letters = 'BCDFGHJKLMNPQRSTVWXZ0123456789';
  const pick = () => letters[(randomBytes(1)[0] ?? 0) % letters.length];
  return `${Array.from({ length: 4 }, pick).join('')}-${Array.from({ length: 4 }, pick).join('')}`;
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(value));
}

// GitHub's OAuth endpoints answer errors with HTTP 200 and an `error` field.
function oauthError(response: ServerResponse, error: string, extra: Record<string, unknown> = {}) {
  json(response, 200, { error, error_description: `${error} (fake GitHub)`, ...extra });
}

async function form(request: IncomingMessage): Promise<Record<string, string>> {
  const text = await body(request);
  if (request.headers['content-type']?.startsWith('application/json')) return JSON.parse(text);
  return Object.fromEntries(new URLSearchParams(text));
}

export async function startFakeGitHub(options: FakeGitHubOptions = {}): Promise<FakeGitHub> {
  const clientId = options.clientId ?? 'Iv23liFakeCommander';
  const appSlug = options.appSlug ?? 'fake-commander';
  const interval = options.interval ?? 5;
  const codeExpiresIn = options.codeExpiresIn ?? 900;
  const tokenExpiresIn = options.tokenExpiresIn === undefined ? 28_800 : options.tokenExpiresIn;
  const deviceFlow = options.deviceFlow ?? true;
  const codes: DeviceCode[] = [];
  const grants: Grant[] = [];
  const personal = new Map<string, Personal>();
  const installations: FakeGitHubInstallation[] = [];
  const orgs: FakeGitHubOrg[] = [];
  const repos: (FakeGitHubRepo & { id: number; nodeId: string })[] = [];
  const contributions: { userId: number; repo: string; kind: 'commit' | 'pull-request' | 'review' }[] = [];
  const pulls: FakeGitHubPullRequest[] = [];
  const issues: FakeGitHubIssue[] = [];
  const releases: FakeGitHubRelease[] = [];
  const commits: FakeGitHubCommit[] = [];
  const teams: FakeGitHubTeam[] = [];
  let throttle: { status: 403 | 429; retryAfter?: number } | null = null;
  // GraphQL points spent, for rateLimit.
  let pointsSpent = 0;
  let restSpent = 0;
  const issued: string[] = [];
  let slowDowns = 0;
  let refreshFailing = false;
  let refreshDelay = 0;

  const fake: FakeGitHub = {
    webUrl: '',
    apiUrl: '',
    clientId,
    appSlug,
    deviceCodeRequests: [],
    tokenRequests: [],
    apiRequests: [],
    refreshes: 0,
    userCodes: () => codes.map((code) => code.userCode),
    enterCode: (code, user = OCTOCAT) => {
      const waiting = codes.find((each) => each.userCode === code && !each.answer && !each.expired);
      if (!waiting) return false;
      waiting.answer = user;
      return true;
    },
    deny: () => {
      const newest = codes.at(-1);
      if (newest) newest.answer = 'denied';
    },
    expire: () => {
      const newest = codes.at(-1);
      if (newest) newest.expired = true;
    },
    slowDown: (polls) => {
      slowDowns = polls;
    },
    personalToken: ({ user = OCTOCAT, kind, scopes = ['repo', 'read:org'] }) => {
      const token = randomToken(PREFIX[kind]);
      personal.set(token, { user, kind, scopes });
      issued.push(token);
      return token;
    },
    install: (installation) => {
      installations.push(installation);
    },
    uninstall: (login) => {
      const index = installations.findIndex((each) => each.login === login);
      if (index >= 0) installations.splice(index, 1);
    },
    addOrg: (org) => {
      orgs.push(org);
    },
    addRepo: (repo) => {
      const nodeId = `R_fake_${repo.owner}_${repo.name}`;
      repos.push({ ...repo, id: 7000 + repos.length, nodeId });
      return nodeId;
    },
    contribute: (userId, repo, kind = 'commit') => {
      contributions.push({ userId, repo, kind });
    },
    addPullRequest: (pull) => {
      pulls.push(pull);
    },
    updatePullRequest: (repo, number, changes) => {
      const pull = pulls.find((each) => each.repo === repo && each.number === number);
      if (pull) Object.assign(pull, { updatedAt: new Date().toISOString() }, changes);
    },
    addIssue: (issue) => {
      issues.push(issue);
    },
    addComment: (repo, number, comment) => {
      const entry =
        pulls.find((each) => each.repo === repo && each.number === number) ??
        issues.find((each) => each.repo === repo && each.number === number);
      if (!entry) return;
      const now = new Date().toISOString();
      entry.comments = [...(entry.comments ?? []), { createdAt: now, ...comment }];
      entry.updatedAt = now;
    },
    pullRequest: (repo, number) => pulls.find((each) => each.repo === repo && each.number === number),
    addRelease: (release) => {
      releases.push(release);
    },
    addCommit: (commit) => {
      commits.push(commit);
    },
    addTeam: (team) => {
      teams.push(team);
    },
    throttleApi: (limit) => {
      throttle = limit;
    },
    revoke: (userId) => {
      for (let i = grants.length - 1; i >= 0; i--) if (grants[i]?.user.id === userId) grants.splice(i, 1);
      for (const [token, each] of personal) if (each.user.id === userId) personal.delete(token);
    },
    failRefreshesTemporarily: (failing) => {
      refreshFailing = failing;
    },
    delayRefreshes: (ms) => {
      refreshDelay = ms;
    },
    secrets: () => [...issued, ...codes.map((code) => code.deviceCode)],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  function grant(user: FakeGitHubUser) {
    const accessToken = randomToken('ghu');
    const refreshToken = tokenExpiresIn === null ? null : randomToken('ghr');
    grants.push({ user, accessToken, refreshToken, kind: 'app' });
    issued.push(accessToken, ...(refreshToken ? [refreshToken] : []));
    return {
      access_token: accessToken,
      token_type: 'bearer',
      scope: '',
      ...(refreshToken
        ? { expires_in: tokenExpiresIn, refresh_token: refreshToken, refresh_token_expires_in: 15_897_600 }
        : {}),
    };
  }

  async function deviceCodeEndpoint(request: IncomingMessage, response: ServerResponse) {
    const fields = await form(request);
    fake.deviceCodeRequests.push(fields);
    if (fields.client_id !== clientId) return json(response, 404, { error: 'Not Found' });
    if (!deviceFlow) return oauthError(response, 'device_flow_disabled');
    const code: DeviceCode = {
      deviceCode: randomBytes(20).toString('hex'),
      userCode: userCode(),
      answer: null,
      expired: false,
    };
    codes.push(code);
    json(response, 200, {
      device_code: code.deviceCode,
      user_code: code.userCode,
      verification_uri: options.verificationUri ?? `${fake.webUrl}/login/device`,
      expires_in: codeExpiresIn,
      interval,
    });
  }

  async function tokenEndpoint(request: IncomingMessage, response: ServerResponse) {
    const fields = await form(request);
    fake.tokenRequests.push(fields);
    // A public GitHub App: no secret is sent, and none is wanted.
    if (fields.client_id !== clientId || 'client_secret' in fields)
      return oauthError(response, 'incorrect_client_credentials');

    if (fields.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
      if (!deviceFlow) return oauthError(response, 'device_flow_disabled');
      const code = codes.find((each) => each.deviceCode === fields.device_code);
      if (!code) return oauthError(response, 'incorrect_device_code');
      if (slowDowns > 0) {
        slowDowns -= 1;
        return oauthError(response, 'slow_down', { interval: interval + 5 });
      }
      if (code.expired) return oauthError(response, 'expired_token');
      if (code.answer === 'denied') return oauthError(response, 'access_denied');
      if (!code.answer) return oauthError(response, 'authorization_pending');
      const user = code.answer;
      // A device code is good for one token.
      code.expired = true;
      return json(response, 200, grant(user));
    }

    if (fields.grant_type === 'refresh_token') {
      if (refreshDelay) await new Promise((resolve) => setTimeout(resolve, refreshDelay));
      if (refreshFailing) return json(response, 503, { message: 'Service Unavailable' });
      const index = grants.findIndex(
        (each) => each.refreshToken && each.refreshToken === fields.refresh_token,
      );
      const old = grants[index];
      if (!old) return oauthError(response, 'bad_refresh_token');
      // Rotation: the old refresh token (and its access token) are spent once a new one is issued.
      grants.splice(index, 1);
      fake.refreshes += 1;
      return json(response, 200, grant(old.user));
    }
    return oauthError(response, 'unsupported_grant_type');
  }

  // Who a request's token signs in as, and how.
  function caller(
    request: IncomingMessage,
  ): { user: FakeGitHubUser; kind: TokenKind; scopes: string[] | null } | null {
    const match = /^(?:Bearer|token) (.+)$/i.exec(request.headers.authorization ?? '');
    const token = match?.[1] ?? '';
    const app = grants.find((each) => each.accessToken === token);
    if (app) return { user: app.user, kind: 'app', scopes: null };
    const pat = personal.get(token);
    if (pat) return { ...pat, scopes: pat.kind === 'fine-grained' ? null : pat.scopes };
    return null;
  }

  const orgOf = (login: string) => orgs.find((each) => each.login.toLowerCase() === login.toLowerCase());
  const accountId = (login: string, user: FakeGitHubUser) =>
    orgOf(login)?.id ?? (login === user.login ? user.id : 9000 + login.length);
  const canReach = (user: FakeGitHubUser, repo: FakeGitHubRepo) =>
    repo.owner === user.login ||
    (orgOf(repo.owner)?.members.includes(user.id) ?? false) ||
    (repo.collaborators ?? []).includes(user.id);
  const ownerType = (login: string) => (orgOf(login) ? 'Organization' : 'User');
  const repoJson = (repo: (typeof repos)[number]) => ({
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private ?? true,
    owner: {
      login: repo.owner,
      id: orgOf(repo.owner)?.id ?? 9000 + repo.owner.length,
      type: ownerType(repo.owner),
    },
    archived: repo.archived ?? false,
    visibility: (repo.private ?? true) ? 'private' : 'public',
    pushed_at: repo.pushedAt === undefined ? '2026-10-01T12:00:00Z' : repo.pushedAt,
  });
  const orgJson = (org: FakeGitHubOrg) => ({ login: org.login, id: org.id, node_id: `O_${org.id}` });
  const installedRepos = (installation: FakeGitHubInstallation) =>
    repos.filter(
      (repo) =>
        repo.owner === installation.login &&
        (installation.repositories === undefined || installation.repositories.includes(repo.name)),
    );
  // One page of a list, as GitHub pages them (per_page, page).
  const paged = <T>(url: URL, list: T[]) => {
    const perPage = Number(url.searchParams.get('per_page') ?? 30);
    const page = Number(url.searchParams.get('page') ?? 1);
    return list.slice((page - 1) * perPage, page * perPage);
  };
  const notForApps = (response: ServerResponse) =>
    json(response, 403, { message: 'Resource not accessible by integration', status: '403' });

  // ----------------------------------------------------------------------------------------------
  // What GitHub sync reads (#114).

  type Caller = NonNullable<ReturnType<typeof caller>>;
  const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
  const restLimit = () => ({
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': String(Math.max(0, 5000 - restSpent)),
    'x-ratelimit-reset': String(inAnHour()),
    'x-ratelimit-resource': 'core',
  });
  const repoNamed = (fullName: string) => repos.find((repo) => `${repo.owner}/${repo.name}` === fullName);
  // Whether a token reaches a repo: through the app's installations, or the User's own access.
  const reaches = (who: Caller, repo: (typeof repos)[number]) => {
    if (who.kind !== 'app') return repo.private === false || canReach(who.user, repo);
    const installed = installations.some((each) => installedRepos(each).includes(repo));
    return installed && (repo.private === false || canReach(who.user, repo));
  };

  // A list GitHub gates with ETags: a 304 (free) when If-None-Match names what it would send.
  function gated(
    request: IncomingMessage,
    response: ServerResponse,
    logged: number,
    value: unknown,
    headers: Record<string, string>,
  ) {
    const text = JSON.stringify(value);
    const etag = `W/"${createHash('sha1').update(text).digest('hex')}"`;
    if (request.headers['if-none-match'] === etag) {
      fake.apiRequests[logged] = `${fake.apiRequests[logged]} 304`;
      response.writeHead(304, { etag, ...restLimit() }).end();
      return;
    }
    restSpent += 1;
    json(response, 200, value, { ...headers, etag, ...restLimit() });
  }

  const updatedOf = (entry: { createdAt?: string; updatedAt?: string }) =>
    entry.updatedAt ?? entry.createdAt ?? '2026-10-01T09:00:00Z';
  const slug = (fullName: string) => fullName.replace('/', '_');
  const repoRef = (repo: (typeof repos)[number]) => ({
    id: repo.nodeId,
    name: repo.name,
    owner: { login: repo.owner },
  });
  const teamRef = (team: string) => {
    const [org, name] = team.split('/');
    return { __typename: 'Team', slug: name, organization: { login: org } };
  };
  const pullId = (pull: FakeGitHubPullRequest) => `PR_fake_${slug(pull.repo)}_${pull.number}`;
  const issueId = (issue: FakeGitHubIssue) => `I_fake_${slug(issue.repo)}_${issue.number}`;

  function pullNode(pull: FakeGitHubPullRequest) {
    const repo = repoNamed(pull.repo);
    if (!repo) throw new Error(`No repo ${pull.repo}`);
    const state = pull.state ?? 'OPEN';
    const updated = updatedOf(pull);
    const asked = [
      ...(pull.reviewers ?? []).map((login) => ({ __typename: 'User', login })),
      ...(pull.teams ?? []).map(teamRef),
    ];
    // Each reviewer's latest review, and GitHub's decision from them.
    const latest = [...new Map((pull.reviews ?? []).map((review) => [review.author, review])).values()];
    const decision = latest.some((review) => review.state === 'CHANGES_REQUESTED')
      ? 'CHANGES_REQUESTED'
      : latest.some((review) => review.state === 'APPROVED')
        ? 'APPROVED'
        : asked.length
          ? 'REVIEW_REQUIRED'
          : null;
    const runs = pull.checkRuns;
    const rollup = runs
      ? runs.some((run) => run.conclusion === 'FAILURE')
        ? 'FAILURE'
        : runs.some((run) => run.conclusion === null)
          ? 'PENDING'
          : 'SUCCESS'
      : pull.checks;
    return {
      __typename: 'PullRequest',
      id: pullId(pull),
      number: pull.number,
      url: `${fake.webUrl}/${pull.repo}/pull/${pull.number}`,
      title: pull.title,
      body: pull.body ?? '',
      isDraft: pull.draft ?? false,
      state,
      createdAt: pull.createdAt ?? updated,
      updatedAt: updated,
      mergedAt: state === 'MERGED' ? updated : null,
      closedAt: state === 'OPEN' ? null : updated,
      additions: 10,
      deletions: 2,
      changedFiles: 1,
      baseRefName: 'main',
      headRefName: `branch-${pull.number}`,
      reviewDecision: decision,
      repository: repoRef(repo),
      author: { login: pull.author, email: pull.authorEmail ?? '', name: pull.authorName ?? null },
      labels: { nodes: (pull.labels ?? []).map((name) => ({ name, color: 'ededed' })) },
      assignees: { nodes: (pull.assignees ?? []).map((login) => ({ login })) },
      reviewRequests: { nodes: asked.map((requestedReviewer) => ({ requestedReviewer })) },
      timelineItems: { nodes: asked.map((requestedReviewer) => ({ createdAt: updated, requestedReviewer })) },
      latestReviews: {
        nodes: latest.map((review) => ({
          author: { login: review.author },
          state: review.state,
          submittedAt: review.submittedAt ?? updated,
        })),
      },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: rollup === null ? null : { state: rollup ?? 'SUCCESS' },
              author: { email: '', user: { login: pull.author } },
            },
          },
        ],
      },
      closingIssuesReferences: {
        nodes: (pull.closes ?? []).flatMap((number) => {
          const closed = issues.find((each) => each.repo === pull.repo && each.number === number);
          return closed
            ? [
                {
                  number,
                  title: closed.title,
                  url: `${fake.webUrl}/${closed.repo}/issues/${number}`,
                  repository: { name: repo.name, owner: { login: repo.owner } },
                },
              ]
            : [];
        }),
      },
    };
  }

  // A pull request's or issue's discussion and checks, as the GitHub Section's query reads them.
  function discussionNode(work: Work, latest: number) {
    const entry = entryOf(work);
    const base = `${fake.webUrl}/${entry.repo}/${work.kind === 'pull' ? 'pull' : 'issues'}/${entry.number}`;
    const all = (entry.comments ?? []).map((comment, index) => ({
      comment,
      node: {
        id: `C_fake_${slug(entry.repo)}_${entry.number}_${index}`,
        url: `${base}#comment-${index}`,
        body: comment.body,
        createdAt: comment.createdAt ?? updatedOf(entry),
        author: { login: comment.author },
      },
    }));
    const conversation = all.filter(({ comment }) => !comment.path);
    const comments = {
      totalCount: conversation.length,
      nodes: conversation.slice(-latest).map(({ node }) => node),
    };
    if (work.kind === 'issue') return { __typename: 'Issue', comments };
    const { pull } = work;
    const reviews = (pull.reviews ?? []).map((review, index) => ({
      id: `R_fake_${slug(pull.repo)}_${pull.number}_${index}`,
      url: `${base}#review-${index}`,
      body: review.body ?? '',
      state: review.state,
      createdAt: review.submittedAt ?? updatedOf(pull),
      submittedAt: review.submittedAt ?? updatedOf(pull),
      author: { login: review.author },
    }));
    const threads = all
      .filter(({ comment }) => comment.path)
      .map(({ comment, node }) => ({
        path: comment.path,
        line: comment.line ?? null,
        originalLine: null,
        comments: { totalCount: 1, nodes: [node] },
      }));
    const contexts = (pull.checkRuns ?? []).map((run) => ({
      __typename: 'CheckRun',
      name: run.name,
      status: run.conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion: run.conclusion,
      detailsUrl: run.url ?? null,
    }));
    return {
      __typename: 'PullRequest',
      comments,
      reviews: { totalCount: reviews.length, nodes: reviews.slice(-latest) },
      reviewThreads: { totalCount: threads.length, nodes: threads.slice(-latest) },
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts } } } }] },
    };
  }

  function issueNode(issue: FakeGitHubIssue) {
    const repo = repoNamed(issue.repo);
    if (!repo) throw new Error(`No repo ${issue.repo}`);
    const state = issue.state ?? 'OPEN';
    const updated = updatedOf(issue);
    return {
      __typename: 'Issue',
      id: issueId(issue),
      number: issue.number,
      url: `${fake.webUrl}/${issue.repo}/issues/${issue.number}`,
      title: issue.title,
      body: issue.body ?? '',
      state,
      stateReason: state === 'CLOSED' ? 'COMPLETED' : null,
      createdAt: issue.createdAt ?? updated,
      updatedAt: updated,
      closedAt: state === 'CLOSED' ? updated : null,
      repository: repoRef(repo),
      author: { login: issue.author, email: '' },
      assignees: { nodes: (issue.assignees ?? []).map((login) => ({ login })) },
      labels: { nodes: (issue.labels ?? []).map((name) => ({ name, color: 'ededed' })) },
      milestone: null,
      comments: { totalCount: 0 },
      parent: null,
      subIssuesSummary: null,
    };
  }

  type Work = { kind: 'pull'; pull: FakeGitHubPullRequest } | { kind: 'issue'; issue: FakeGitHubIssue };
  const workOf = (): Work[] => [
    ...pulls.map((pull) => ({ kind: 'pull' as const, pull })),
    ...issues.map((issue) => ({ kind: 'issue' as const, issue })),
  ];
  const entryOf = (work: Work) => (work.kind === 'pull' ? work.pull : work.issue);
  const nodeOf = (work: Work) => (work.kind === 'pull' ? pullNode(work.pull) : issueNode(work.issue));

  // Whether a time is in a search qualifier's window (">=T" or "A..B").
  function inWindow(time: string | null, window: string): boolean {
    if (time === null) return false;
    const at = Date.parse(time);
    if (window.startsWith('>=')) return at >= Date.parse(window.slice(2));
    const [from, to] = window.split('..');
    return at >= Date.parse(from ?? '') && at <= Date.parse(to ?? '');
  }

  // The pull requests and issues a search finds for the caller, most recently updated first.
  function search(query: string, who: Caller): Work[] {
    const myTeams = teams
      .filter((team) => team.members.includes(who.user.id))
      .map((team) => `${team.org}/${team.slug}`.toLowerCase());
    const mine = (logins: string[] | undefined) => (logins ?? []).includes(who.user.login);
    const matches = (work: Work, term: string) => {
      const entry = entryOf(work);
      const open = (entry.state ?? 'OPEN') === 'OPEN';
      const [qualifier, value = ''] = term.split(/:(.*)/s);
      switch (term) {
        case 'is:open':
          return open;
        case 'is:closed':
          return !open;
        case 'is:pr':
          return work.kind === 'pull';
        case 'is:issue':
          return work.kind === 'issue';
        case 'author:@me':
          return entry.author === who.user.login;
        case 'assignee:@me':
          return mine(entry.assignees);
        case 'user-review-requested:@me':
          return work.kind === 'pull' && mine(work.pull.reviewers);
        case 'team-review-requested:@me':
          return (
            work.kind === 'pull' &&
            (work.pull.teams ?? []).some((team) => myTeams.includes(team.toLowerCase()))
          );
      }
      if (qualifier === 'org' || qualifier === 'user')
        return entry.repo.split('/')[0]?.toLowerCase() === value.toLowerCase();
      if (qualifier === 'updated') return inWindow(updatedOf(entry), value);
      if (qualifier === 'created') return inWindow(entry.createdAt ?? updatedOf(entry), value);
      if (qualifier === 'closed') return inWindow(open ? null : updatedOf(entry), value);
      return true;
    };
    const terms = query.trim().split(/\s+/);
    return workOf()
      .filter((work) => {
        const repo = repoNamed(entryOf(work).repo);
        return repo !== undefined && reaches(who, repo) && terms.every((term) => matches(work, term));
      })
      .sort((a, b) => Date.parse(updatedOf(entryOf(b))) - Date.parse(updatedOf(entryOf(a))));
  }

  // One page of a search, as GraphQL's search connection answers it.
  function searchPage(query: string, who: Caller, first: number, after: string | null) {
    const found = search(query, who);
    const start = after ? Number(after) : 0;
    const page = found.slice(start, start + first);
    const end = start + page.length;
    return {
      issueCount: found.length,
      pageInfo: { hasNextPage: end < found.length, endCursor: page.length ? String(end) : null },
      nodes: page.map(nodeOf),
    };
  }

  function repoNode(repo: (typeof repos)[number], since: string) {
    const fullName = `${repo.owner}/${repo.name}`;
    const theirs = commits.filter((commit) => commit.repo === fullName);
    const head = theirs.at(-1);
    return {
      ...repoRef(repo),
      defaultBranchRef: {
        name: 'main',
        target: {
          oid: head ? createHash('sha1').update(head.message).digest('hex') : `head-${repo.name}`,
          committedDate: head?.committedAt ?? repo.pushedAt ?? '2026-10-01T12:00:00Z',
          statusCheckRollup: { state: 'SUCCESS' },
          history: {
            nodes: theirs
              .filter((commit) => Date.parse(commit.committedAt) >= Date.parse(since))
              .reverse()
              .map((commit) => ({
                oid: createHash('sha1').update(commit.message).digest('hex'),
                messageHeadline: commit.message.split('\n')[0],
                message: commit.message,
                committedDate: commit.committedAt,
                author: {
                  name: commit.author,
                  email: `${commit.author}@example.test`,
                  user: { login: commit.author },
                },
              })),
          },
        },
      },
      releases: {
        nodes: releases
          .filter((release) => release.repo === fullName)
          .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
          .map((release) => ({
            id: `RE_fake_${slug(fullName)}_${release.tag}`,
            tagName: release.tag,
            name: release.name ?? null,
            url: `${fake.webUrl}/${fullName}/releases/tag/${release.tag}`,
            isDraft: false,
            isPrerelease: false,
            publishedAt: release.publishedAt,
            description: release.notes ?? '',
            author: { login: 'octocat' },
          })),
      },
    };
  }

  // The open-work searches GitHub sync sends in one request.
  const OPEN_WORK = {
    mine: 'is:open is:pr author:@me',
    direct: 'is:open is:pr user-review-requested:@me',
    team: 'is:open is:pr team-review-requested:@me',
    assigned: 'is:open is:issue assignee:@me',
  };

  // GitHub sync's GraphQL operations; null for any other.
  function syncQuery(operationName: string, variables: Record<string, unknown>, who: Caller): unknown {
    switch (operationName) {
      case 'CommanderOpenWork': {
        const first = Number(variables.first ?? 100);
        return {
          viewer: { login: who.user.login },
          ...Object.fromEntries(
            Object.entries(OPEN_WORK).map(([alias, query]) => [alias, searchPage(query, who, first, null)]),
          ),
        };
      }
      case 'CommanderNodes':
        return {
          nodes: ((variables.ids as string[]) ?? []).map((id) => {
            const work = workOf().find(
              (each) => (each.kind === 'pull' ? pullId(each.pull) : issueId(each.issue)) === id,
            );
            const repo = work ? repoNamed(entryOf(work).repo) : undefined;
            return work && repo && reaches(who, repo) ? nodeOf(work) : null;
          }),
        };
      case 'CommanderSearchCount':
        return { search: { issueCount: search(String(variables.query), who).length } };
      case 'CommanderOpenWorkPage':
      case 'CommanderSearch':
        return {
          search: searchPage(
            String(variables.query),
            who,
            Number(variables.first ?? 100),
            (variables.after as string | null) ?? null,
          ),
        };
      case 'CommanderRepos':
        return {
          nodes: ((variables.ids as string[]) ?? []).map((id) => {
            const repo = repos.find((each) => each.nodeId === id);
            return repo && reaches(who, repo) ? repoNode(repo, String(variables.since)) : null;
          }),
        };
      case 'CommanderDiscussion': {
        const work = workOf().find(
          (each) => (each.kind === 'pull' ? pullId(each.pull) : issueId(each.issue)) === variables.id,
        );
        const repo = work ? repoNamed(entryOf(work).repo) : undefined;
        return {
          node:
            work && repo && reaches(who, repo) ? discussionNode(work, Number(variables.latest ?? 50)) : null,
        };
      }
      case 'CommanderSweep':
        return {
          items: ((variables.ids as string[]) ?? []).map((id) => {
            const pull = pulls.find((each) => pullId(each) === id);
            const issue = issues.find((each) => issueId(each) === id);
            const entry = pull ?? issue;
            const repo = entry ? repoNamed(entry.repo) : undefined;
            if (!entry || !repo) return null;
            return {
              __typename: pull ? 'PullRequest' : 'Issue',
              id,
              number: entry.number,
              repository: { id: repo.nodeId },
            };
          }),
          repos: ((variables.repos as string[]) ?? []).map((id) => {
            const repo = repos.find((each) => each.nodeId === id);
            return repo && reaches(who, repo) ? { id } : null;
          }),
        };
      default:
        return null;
    }
  }

  // The issues and pull requests of some repos, as REST lists them (most recently updated first).
  const restIssues = (who: Caller, inRepo: (repo: (typeof repos)[number]) => boolean) =>
    workOf()
      .filter((work) => {
        const repo = repoNamed(entryOf(work).repo);
        return repo !== undefined && inRepo(repo) && reaches(who, repo);
      })
      .sort((a, b) => Date.parse(updatedOf(entryOf(b))) - Date.parse(updatedOf(entryOf(a))))
      .map((work) => {
        const entry = entryOf(work);
        return {
          number: entry.number,
          title: entry.title,
          state: (entry.state ?? 'OPEN') === 'OPEN' ? 'open' : 'closed',
          updated_at: updatedOf(entry),
          ...(work.kind === 'pull' ? { pull_request: { url: '' } } : {}),
        };
      });

  async function api(request: IncomingMessage, url: URL, response: ServerResponse) {
    const path = url.pathname.slice('/api'.length) || '/';
    const logged = fake.apiRequests.push(`${request.method} ${path}`) - 1;
    // GitHub refuses requests without a User-Agent.
    if (!request.headers['user-agent'])
      return json(response, 403, { message: 'Request forbidden by administrative rules.' });
    const who = caller(request);
    if (!who) return json(response, 401, { message: 'Bad credentials', status: '401' });
    // Classic and OAuth tokens list their scopes; GitHub App and fine-grained tokens don't.
    const headers: Record<string, string> = who.scopes ? { 'x-oauth-scopes': who.scopes.join(', ') } : {};
    if (throttle) {
      const limited = {
        ...restLimit(),
        ...(throttle.status === 403 ? { 'x-ratelimit-remaining': '0' } : {}),
        ...(throttle.retryAfter !== undefined ? { 'retry-after': String(throttle.retryAfter) } : {}),
      };
      return json(
        response,
        throttle.status,
        {
          message:
            'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
        },
        limited,
      );
    }

    if (request.method === 'GET' && path === '/user/teams') {
      // A GitHub App's user token may not read teams without the members permission: refused here,
      // the cautious reading.
      if (who.kind === 'app') return notForApps(response);
      const mine = teams.filter((team) => team.members.includes(who.user.id));
      const listed = mine.map((team) => ({
        slug: team.slug,
        name: team.slug,
        organization: { login: team.org },
      }));
      return gated(request, response, logged, paged(url, listed), headers);
    }
    const orgIssues = /^\/orgs\/([^/]+)\/issues$/.exec(path);
    if (request.method === 'GET' && orgIssues) {
      const org = orgOf(decodeURIComponent(orgIssues[1] ?? ''));
      // Only for the org's members.
      if (!org?.members.includes(who.user.id)) return json(response, 404, { message: 'Not Found' });
      return gated(
        request,
        response,
        logged,
        paged(
          url,
          restIssues(who, (repo) => repo.owner === org.login),
        ),
        headers,
      );
    }
    const repoIssues = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(path);
    if (request.method === 'GET' && repoIssues) {
      const fullName = `${decodeURIComponent(repoIssues[1] ?? '')}/${decodeURIComponent(repoIssues[2] ?? '')}`;
      const repo = repoNamed(fullName);
      if (!repo || !reaches(who, repo)) return json(response, 404, { message: 'Not Found' });
      return gated(
        request,
        response,
        logged,
        paged(
          url,
          restIssues(who, (each) => each === repo),
        ),
        headers,
      );
    }

    if (request.method === 'GET' && path === '/user') {
      const { id, login, name } = who.user;
      return json(response, 200, { login, id, node_id: `U_${id}`, type: 'User', name }, headers);
    }
    if (request.method === 'GET' && path === '/user/installations') {
      if (who.kind !== 'app') {
        return json(response, 403, {
          message:
            'You must authenticate with an access token authorized to a GitHub App in order to list installations',
        });
      }
      const perPage = Number(url.searchParams.get('per_page') ?? 30);
      const page = Number(url.searchParams.get('page') ?? 1);
      const listed = installations.slice((page - 1) * perPage, page * perPage);
      return json(response, 200, {
        total_count: installations.length,
        installations: listed.map((each) => ({
          id: 1000 + installations.indexOf(each),
          app_slug: appSlug,
          account: { login: each.login, id: accountId(each.login, who.user), type: each.type },
          target_type: each.type,
          repository_selection: each.repositories ? 'selected' : 'all',
        })),
      });
    }
    const installationRepos = /^\/user\/installations\/(\d+)\/repositories$/.exec(path);
    if (request.method === 'GET' && installationRepos) {
      if (who.kind !== 'app') return json(response, 403, { message: 'Must authenticate with a GitHub App' });
      const installation = installations[Number(installationRepos[1]) - 1000];
      if (!installation) return json(response, 404, { message: 'Not Found' });
      const reachable = installedRepos(installation).filter((repo) => canReach(who.user, repo));
      return json(response, 200, {
        total_count: reachable.length,
        repository_selection: installation.repositories ? 'selected' : 'all',
        repositories: paged(url, reachable).map(repoJson),
      });
    }
    if (request.method === 'GET' && path === '/user/memberships/orgs') {
      if (who.kind === 'app') return notForApps(response);
      const mine = orgs.filter((org) => org.members.includes(who.user.id));
      return json(
        response,
        200,
        paged(url, mine).map((org) => ({ state: 'active', role: 'member', organization: orgJson(org) })),
        headers,
      );
    }
    if (request.method === 'GET' && path === '/user/orgs') {
      if (who.kind === 'app') return notForApps(response);
      const mine = orgs.filter((org) => org.members.includes(who.user.id));
      return json(response, 200, paged(url, mine).map(orgJson), headers);
    }
    const publicOrgs = /^\/users\/([^/]+)\/orgs$/.exec(path);
    if (request.method === 'GET' && publicOrgs) {
      const login = decodeURIComponent(publicOrgs[1] ?? '');
      const users = [...grants.map((each) => each.user), ...[...personal.values()].map((each) => each.user)];
      const user = users.find((each) => each.login === login);
      const theirs = user ? orgs.filter((org) => (org.publicMembers ?? []).includes(user.id)) : [];
      return json(response, 200, paged(url, theirs).map(orgJson), headers);
    }
    const orgRepos = /^\/orgs\/([^/]+)\/repos$/.exec(path);
    if (request.method === 'GET' && orgRepos) {
      const org = orgOf(decodeURIComponent(orgRepos[1] ?? ''));
      if (!org) return json(response, 404, { message: 'Not Found' });
      const installation = installations.find((each) => each.login === org.login);
      const visible = repos.filter((repo) => {
        if (repo.owner !== org.login) return false;
        if (repo.private === false) return true;
        if (who.kind === 'app') return installation ? installedRepos(installation).includes(repo) : false;
        return canReach(who.user, repo);
      });
      if (url.searchParams.get('sort') === 'pushed')
        visible.sort(
          (a, b) => Date.parse(b.pushedAt ?? '1970-01-01') - Date.parse(a.pushedAt ?? '1970-01-01'),
        );
      return gated(request, response, logged, paged(url, visible).map(repoJson), headers);
    }
    const orgPath = /^\/orgs\/([^/]+)$/.exec(path);
    if (request.method === 'GET' && orgPath) {
      const org = orgOf(decodeURIComponent(orgPath[1] ?? ''));
      if (!org) return json(response, 404, { message: 'Not Found' });
      return json(response, 200, { ...orgJson(org), type: 'Organization' }, headers);
    }
    if (request.method === 'GET' && path === '/user/repos') {
      const reachable = repos.filter((repo) => canReach(who.user, repo));
      if (url.searchParams.get('sort') === 'pushed')
        reachable.sort(
          (a, b) => Date.parse(b.pushedAt ?? '1970-01-01') - Date.parse(a.pushedAt ?? '1970-01-01'),
        );
      return gated(request, response, logged, paged(url, reachable).map(repoJson), headers);
    }
    if (request.method === 'POST' && path === '/graphql') {
      const { query, operationName, variables } = JSON.parse(await body(request)) as {
        query?: string;
        operationName?: string;
        variables?: Record<string, unknown>;
      };
      if (operationName) fake.apiRequests[logged] = `POST /graphql ${operationName}`;
      const answer = operationName ? syncQuery(operationName, variables ?? {}, who) : null;
      if (answer) {
        pointsSpent += 1;
        const rateLimit = {
          cost: 1,
          limit: 5000,
          remaining: Math.max(0, 5000 - pointsSpent),
          resetAt: new Date(inAnHour() * 1000).toISOString(),
        };
        return json(
          response,
          200,
          { data: { ...(answer as object), rateLimit } },
          {
            'x-ratelimit-limit': '5000',
            'x-ratelimit-remaining': String(rateLimit.remaining),
            'x-ratelimit-reset': String(inAnHour()),
            'x-ratelimit-resource': 'graphql',
          },
        );
      }
      if (query?.includes('contributionsCollection')) {
        const byKind = (kind: 'commit' | 'pull-request' | 'review') =>
          contributions
            .filter((each) => each.userId === who.user.id && each.kind === kind)
            .flatMap((each) => repos.filter((repo) => `${repo.owner}/${repo.name}` === each.repo))
            .map((repo) => ({
              repository: { id: repo.nodeId, nameWithOwner: `${repo.owner}/${repo.name}` },
            }));
        return json(response, 200, {
          data: {
            viewer: {
              login: who.user.login,
              contributionsCollection: {
                commitContributionsByRepository: byKind('commit'),
                pullRequestContributionsByRepository: byKind('pull-request'),
                pullRequestReviewContributionsByRepository: byKind('review'),
              },
            },
          },
        });
      }
      if (query?.includes('viewer'))
        return json(response, 200, { data: { viewer: { login: who.user.login, databaseId: who.user.id } } });
      return json(response, 200, { errors: [{ message: 'Not in the fake.' }] });
    }
    return json(response, 404, { message: 'Not Found' });
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'POST' && url.pathname === '/login/device/code')
      return void deviceCodeEndpoint(request, response);
    if (request.method === 'POST' && url.pathname === '/login/oauth/access_token')
      return void tokenEndpoint(request, response);
    if (request.method === 'GET' && (url.pathname === '/login/device' || url.pathname.startsWith('/apps/')))
      return void response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Fake GitHub</h1>');
    if (url.pathname.startsWith('/api/')) return void api(request, url, response);
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  fake.webUrl = `http://127.0.0.1:${port}`;
  fake.apiUrl = `http://127.0.0.1:${port}/api`;
  return fake;
}
