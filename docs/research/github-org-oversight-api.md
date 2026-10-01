# GitHub API for org-wide oversight

Research for wayfinder ticket #5. It feeds decision ticket #18 (GitHub oversight summary: contents, cadence and scope controls).

Researched on 2026-10-01. Claims come from GitHub's own documentation, the GitHub changelog, and the live GraphQL schema. Some points have no documented answer, or the docs disagree with how the API behaves. For those I ran read-only checks against `api.github.com` on 2026-10-01, signed in with a GitHub CLI OAuth token (classic scopes `repo`, `read:org`, `gist`, `workflow`). Those results are marked **Observed**. They show what happened on one account on one day. They are not guarantees from GitHub.

## Question

How should a desktop app that runs entirely on the User's machine get a summary of all work across every repo in the orgs a User chooses, plus their own open work, limited to what that User can access?

Sub-questions from the ticket:

1. **Auth options.** GitHub App (user-to-server tokens, device flow), OAuth App, or fine-grained PAT. Which works for a desktop app across orgs the User doesn't own, and how much org-approval friction does each carry?
2. **Listing what changed across many repos.** Org events, repo events, GraphQL search, and commits/PRs/reviews/issues/releases since a timestamp, plus the limits of each (such as event history windows).
3. **Rate limits** for an org with 50–200 repos, and GraphQL point costs.
4. **The cheapest queries for open work.** Authored PRs, review requests, assigned issues.
5. **Change detection without a public endpoint.** Polling with conditional requests (ETags).

## Short answer

- **Auth.** Use a **public GitHub App** that Commander's author registers. Turn webhooks off and device flow on, keep expiring user tokens, and ship only the client ID.
  - Device flow needs no client secret, either to get the token or to refresh it. That suits an app with no server ([user token docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [refresh docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)).
  - The catch is org friction. A GitHub App only sees an org's private repos once that org has **installed** it. Installing takes an org owner, or a repo admin for the repos they admin. Members can only *request* an install ([on-behalf-of-user docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user), [installing docs](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party)).
  - A **classic PAT** is the lowest-friction fallback: one token covers every org with no owner action, unless an org blocks classic PATs. The costs are that `repo` is a full read/write scope and SAML orgs need per-token SSO authorization.
  - A **fine-grained PAT** covers one org per token, and needs owner approval by default.
  - An **OAuth App** needs owner approval in any org with OAuth app access restrictions, which are on by default for new orgs. Its private-repo scope (`repo`) is also full write.
- **Listing changes.** Webhooks are out, because they need a public URL. Poll instead, and use cheap "did anything change?" checks to decide when to run the detailed queries:
  1. Per org, make two fixed-URL REST list calls with `If-None-Match`: repos sorted by `pushed`, and org issues/PRs sorted by `updated`. A `304` costs nothing against the primary limit.
  2. Only when one of them changes, run GraphQL. Use `search(org:X updated:>=T)` for issues and PRs, then one batched query over the repos whose `pushedAt` moved, for commits, PRs, reviews and releases.
  - The Events API has hard limits: 300 events or 30 days, documented latency of "30s to 6h", and slimmed payloads since 2025-10-07. Treat it as a hint, not the record ([events docs](https://docs.github.com/en/rest/activity/events), [payload changelog](https://github.blog/changelog/2025-08-08-upcoming-changes-to-github-events-api-payloads/)).
- **Rate limits.** Point budgets will not be the binding constraint for 50–200 repos.
  - A user token gets 5,000 REST requests/hour and 5,000 GraphQL points/hour. That budget is **shared** with every other app and PAT acting as that user ([REST limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)).
  - The polling loop above costs single-digit points per cycle.
  - The real limit is the **10-second GraphQL timeout** and the per-query resource limits. A 100-repo query with per-repo commit counts timed out; timeouts also cost extra points (Observed).
- **Open work.** One GraphQL request with three aliased `search` fields covers authored PRs, review requests and assigned issues for **1 point** (Observed). The qualifiers are `author:@me`, `review-requested:@me` and `assignee:@me` ([search qualifiers](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests)).
- **Change detection.** REST supports `ETag`/`If-None-Match` and `Last-Modified`/`If-Modified-Since`. An authorized `304` does not count against the primary limit ([REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)). GraphQL and search responses carry no ETag (Observed). So poll with cheap REST conditional requests first, and spend GraphQL points only when something changed.

## 1. Auth options

### Comparison

| | GitHub App (user access token) | OAuth App | Fine-grained PAT | Classic PAT |
|---|---|---|---|---|
| One credential across many orgs | Yes, but private data only from orgs where the app is **installed** | Yes, but private data only from orgs that **approved** the app, if restrictions are on | **No**: one resource owner per token | Yes |
| Who must act in an org the User doesn't own | Org owner installs, or a repo admin installs on repos they admin | Org owner approves, if OAuth restrictions are on (default for new orgs) | Org owner approves the token (default on) | Nobody, unless the org blocks classic PATs or sets a maximum lifetime the token exceeds |
| Read-only private access possible | Yes (per-permission read) | No (`repo` is full read/write) | Yes | No (`repo` is full read/write) |
| Ships a secret in the app | No, with device flow | Device flow needs no secret | n/a (User pastes token) | n/a |
| Token lifetime | 8 h access / 6 months refresh (opt-out possible) | Long-lived by default; expiring tokens available since 2026-08-14 | Up to the org's max lifetime (default policy 366 days) | No expiry required by GitHub, but an org may enforce a maximum lifetime |
| Notifications API | Not supported | Worked with an OAuth app token (Observed; the docs name only classic PATs) | Not supported | Supported |
| Rate limit | User's shared 5,000/h | User's shared 5,000/h | User's shared 5,000/h | User's shared 5,000/h |

Sources for each row are given in the subsections below.

### GitHub App with user access tokens

- **How access is decided.** "A user access token only has permissions that both the user and the app have" and "can only access resources that both the user and app can access" ([generating a user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)).
  - "The app can only access resources in an account where it is installed. If your app is only installed on a user's personal account, it cannot access resources in an organization that the user is a member of unless the app is also installed on that organization" ([acting on behalf of a user](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)).
  - Public data is readable without an install: GitHub Apps "have implicit permissions to read public resources when acting on behalf of a user" ([choosing permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)).
- **Who can install.** "Organization owners can install GitHub Apps on their organization". Repository admins can install only if the app requests no organization permissions and no repository administration permission, and then "only … with access to the repositories that they admin". The "app manager" role cannot install ([installing a third-party app](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party)).
  - The installer chooses "All repositories" or "Only select repositories" (same source). That choice is an org-side scope control Commander must respect.
- **Requesting an install.** "Organization members can request installation of a GitHub App for their organization", and the owner is emailed. By default outside collaborators can request too (see the request controls below) ([requesting an app](https://docs.github.com/en/apps/using-github-apps/requesting-a-github-app-from-your-organization-owner)).
  - **New: public preview on 2025-12-22, generally available since 2026-01-12:** the default is "Members and outside collaborators", and orgs can limit app requests to "Members only" or "Disable app access requests". This applies to GitHub Apps and OAuth apps alike ([preview changelog](https://github.blog/changelog/2025-12-22-control-who-can-request-apps-for-your-organization/), [GA changelog](https://github.blog/changelog/2026-01-12-controlling-who-can-request-apps-for-your-organization-is-now-generally-available/)). The setting is under Member Privileges, "App access requests". In such orgs the User may not even be able to ask.
- **GitHub Apps ignore OAuth app policies.** "GitHub Apps aren't subject to organization application policies. A GitHub App only has access to the repositories an organization owner has granted" ([differences between app types](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps)).
- **The app must be public.**
  - A private app "can only be installed on the account that owns the app", and "Only members of the organization that owns it can authorize it" ([public or private apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private)).
  - Since 2025-06-24 GitHub enforces this on sign-in: "to sign into an app, users must now be a member of the enterprise if it is internal, or the owning organization if it's private" ([changelog](https://github.blog/changelog/2025-06-24-security-updates-for-apps-and-api-access/)).
  - So for testers, and later other Users, the Commander app must be registered with "Any account" ([registering an app](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)).
- **No server needed.**
  - Webhooks can be switched off: "if you do not want your app to receive webhook events, deselect **Active**" ([registering an app](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)).
  - The private key must never ship: "you must never ship your private key with your app" ([GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)). That rules out **installation** tokens in a serverless desktop app, leaving only user access tokens.
- **Device flow.**
  - Device flow must be enabled in the app settings.
  - Token polling sends only `client_id`, `device_code` and `grant_type`.
  - The device code expires after 900 s by default ([generating a user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)).
  - Refreshing needs `client_secret` "unless the user access token was generated using the device flow" ([refreshing tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)).
  - User tokens last 8 hours (`expires_in` 28800) and refresh tokens 6 months (`15897600`). Expiry can be opted out of, but GitHub "strongly recommends" leaving it on ([generating a user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [registering an app](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)).
- **The docs disagree about desktop apps.**
  - The token guide says "CLI tools, simple Raspberry Pis, and desktop applications should use the device flow" ([generating a user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)).
  - The best-practices page says, for public clients, "It is preferable to use the authorization code with PKCE over the device flow", because an attacker can use device flow to impersonate the app in phishing. It also concedes native apps "have to ship the client secret" for the web flow ([GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)).
  - PKCE (S256 only) has been supported since 2025-07-14 but is not required ([changelog](https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/)).
  - Trade-off: device flow means no secret in the binary but some phishing exposure. PKCE web flow means a shipped, extractable client secret plus a loopback redirect.
  - **Unverified:** whether GitHub App callback URLs accept a loopback redirect on an arbitrary port. The OAuth app docs explicitly allow it. The GitHub App callback doc only says, for wildcard matching, that host and port "must exactly match" ([callback URL docs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url)). Spike this if PKCE is chosen.
- **SAML SSO.** "You must have an active SSO session each time you authorize an OAuth app or GitHub App in order to access an organization that uses or enforces SSO" ([SSO overview](https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-single-sign-on/about-authentication-with-single-sign-on)).
- **Discovering the User's orgs.**
  - `GET /user/orgs` returns "a 200 Success response with an empty list" for fine-grained access tokens ([orgs REST](https://docs.github.com/en/rest/orgs/orgs)).
  - With a GitHub App, use `GET /user/installations` and `GET /user/installations/{id}/repositories`. These list the installations and repos that the user "has explicit permission … to access" ([installations REST](https://docs.github.com/en/rest/apps/installations)).
  - **Unverified:** how to list orgs the User belongs to where the app is *not* installed, so Commander can prompt an install request. `GET /user/orgs` and `GET /user/memberships/orgs` are both listed as available to GitHub App user access tokens with no permission required ([endpoints for user access tokens](https://docs.github.com/en/rest/authentication/endpoints-available-for-github-app-user-access-tokens)), but the docs do not say whether they are filtered to installed orgs. Spike those two and `viewer { organizations }` with a user token. Note that the per-org `GET /user/memberships/orgs/{org}` needs the organization "Members" permission, which would close the repo-admin install path.
- **Permissions to request.** Map each endpoint to its permission ([GitHub App permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)):
  - Metadata: read (repo lists, repo events).
  - Contents: read (commits, releases).
  - Issues: read.
  - Pull requests: read.
  - Organization "Events": read, only if the org dashboard events feed is used. Any organization permission stops repo admins from self-installing (see above), so skipping it keeps that install path open.

### OAuth App

- **Org approval.**
  - "When you create a new organization, OAuth app access restrictions are enabled by default."
  - "API access to private organization resources is not available for unapproved OAuth apps."
  - Users can request owner approval ([OAuth app access restrictions](https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions)).
- **Scopes are coarse.** `repo` "Grants full access to public and private repositories including read and write access to code…". No scope gives read-only access to private repos ([OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)).
- **Desktop-friendly.**
  - Device flow needs only `client_id`.
  - Loopback redirects to `127.0.0.1` on any port are documented for "native applications running on a desktop computer".
  - Limit: "ten tokens … per user/application/scope combination" ([authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)).
- **Recent change (2026-08-14).** OAuth apps can now get expiring tokens (8 h access; the refresh token "expires after six months without use" per [authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)) via the `offline_access` scope, and "Short-lived tokens are enabled by default for all new applications" ([changelog](https://github.blog/changelog/2026-08-14-multiple-redirect-uris-and-token-refresh-for-oauth-apps/)). A newly registered Commander OAuth app would therefore have to handle refresh too. As with GitHub Apps, the OAuth refresh call needs `client_secret` "unless the token was generated using the device flow" (same source), so refresh stays secret-free.
- **Verdict.** Approval friction similar to a GitHub App's, but broader write power and no per-repo selection. No advantage for Commander, except that OAuth tokens can call the Notifications API (see section 4).

### Fine-grained PAT

- **Status.** Generally available since 2025-03-18. Enabled by default for orgs, with "The PAT approval flow … also enabled by default" ([changelog](https://github.blog/changelog/2025-03-18-fine-grained-pats-are-now-generally-available/)).
- **One org per token.** "Each token is limited to access resources owned by a single user or organization." The docs list "access multiple organizations at once" and contributing "to repositories where the user is an outside or repository collaborator" as unsupported, and state that "Outside collaborators can only use personal access tokens (classic) to access organization repositories that they are a collaborator on" ([managing PATs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)). So a User who only collaborates on a repo, without org membership, cannot use a fine-grained PAT there.
- **Org policies.**
  - Requiring approval "is the default value".
  - The default maximum lifetime policy is 366 days.
  - "Only fine-grained personal access tokens, not personal access tokens (classic), are subject to approval" ([PAT policy](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization)).
- **SSO.** Fine-grained PATs "are authorized during token creation" ([PAT SSO](https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-single-sign-on/authorizing-a-personal-access-token-for-use-with-single-sign-on)).
- **Verdict.** Per-org token juggling, plus owner approval for each. Workable for one or two orgs, poor for "every org I choose".

### Classic PAT, and reusing the `gh` token

- **Restrictions.**
  - Org owners can block classic PATs.
  - Classic PATs are not subject to approval, and GitHub itself requires no expiry. However, "Organization owners can set maximum lifetime allowances for both fine-grained personal access tokens and personal access tokens (classic)", and a non-compliant token held by a member is then blocked from that org ([PAT policy](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization)).
  - In SAML orgs a classic PAT must be authorized for SSO after it is created ([PAT SSO](https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-single-sign-on/authorizing-a-personal-access-token-for-use-with-single-sign-on)).
- **Lowest friction.** One token sees every org and repo the User can see, with no owner involvement. The costs: full write scope, a long-lived secret on disk, and the User has to create and paste it.
- **Reusing `gh`.** If the User already has the GitHub CLI, `gh auth token` "outputs the authentication token for an account" ([gh auth token](https://cli.github.com/manual/gh_auth_token)). That token carries `repo`, `read:org` and `gist` ([gh auth login](https://cli.github.com/manual/gh_auth_login)). This is a quick path for the author's own machine. Commander's traffic would then run under the GitHub CLI's OAuth grant, so it is not a product auth design.

## 2. Listing what changed across many repos

### Events API

- **Endpoints** ([events REST](https://docs.github.com/en/rest/activity/events)):
  - `GET /orgs/{org}/events`: **public** org events only.
  - `GET /users/{username}/events/orgs/{org}`: "the user's organization dashboard", including private events, and "You must be authenticated as the user".
  - `GET /repos/{owner}/{repo}/events`: one repo's events.
- **Hard limits.** "The timeline will include up to 300 events. Only events created within the past 30 days will be included" ([events REST](https://docs.github.com/en/rest/activity/events)).
  - The retention window was cut from 90 to 30 days, effective 2025-01-30 ([changelog](https://github.blog/changelog/2024-11-08-upcoming-changes-to-data-retention-for-events-api-atom-feed-timeline-and-dashboard-feed-features/)).
  - For a busy 200-repo org, 300 events may cover less than a day. A Commander that was offline longer cannot backfill from events.
- **Latency (docs disagree).**
  - Each endpoint still says "event latency can be anywhere from 30s to 6h" ([events REST](https://docs.github.com/en/rest/activity/events), checked 2026-10-01).
  - The 2025-08-08 changelog says that, after the change took effect on 2025-10-07, events "will be available almost immediately" instead of "up to eight hours" ([changelog](https://github.blog/changelog/2025-08-08-upcoming-changes-to-github-events-api-payloads/)).
  - Treat latency as unreliable.
- **Slimmed payloads (since 2025-10-07).**
  - Push events lost "commit summaries and counts", and pull request payloads were trimmed ([changelog](https://github.blog/changelog/2025-08-08-upcoming-changes-to-github-events-api-payloads/)).
  - The current PushEvent payload is only `repository_id`, `push_id`, `ref`, `head`, `before` ([event types](https://docs.github.com/en/rest/using-the-rest-api/github-event-types)).
  - **Observed:** a live PushEvent had exactly those five keys.
  - So every push event needs a follow-up call to learn which commits were pushed.
- **Polling support.** Events support ETag/`304` and an `X-Poll-Interval` header. **Observed:** `X-Poll-Interval: 60`.
- **Token support.** The org dashboard endpoint works with GitHub App user tokens and fine-grained PATs, with the organization "Events" (read) permission ([events REST](https://docs.github.com/en/rest/activity/events)).

### Search (issues and PRs)

- **One query covers an org.** `search(type: ISSUE, query: "org:X updated:>=2026-09-30T08:00:00Z")` covers every issue and PR in the org that the token can see.
  - Dates accept `THH:MM:SS+00:00` or `Z` ([search syntax](https://docs.github.com/en/search-github/getting-started-with-searching-on-github/understanding-the-search-syntax)).
  - `updated` changes when a PR gets reviews or comments, so this also catches review activity on PRs. **Unverified:** exactly which actions bump `updatedAt`.
- **Hard limits.**
  - At most 1,000 results per search, both in REST and in the GraphQL `search` field ("returning a maximum of 1,000 results", per live schema introspection) ([REST search](https://docs.github.com/en/rest/search/search)).
  - REST search allows 30 requests/minute. Semantic and hybrid search are limited to 10/minute.
  - **Observed:** `org:github updated:>=2026-09-30` returned 1,274 results, so a large org can exceed the cap within about a day. Poll often enough, or split the time window.
  - **Observed:** GraphQL `search` calls drew GraphQL points (1 each). They did **not** use up the REST `search` bucket.
- **GitHub App user tokens.** REST search queries must include `is:issue` or `is:pull-request`. Otherwise they get a 422 ([REST search](https://docs.github.com/en/rest/search/search)). **Unverified:** whether the GraphQL `search` field has the same restriction.
- **Advanced vs legacy syntax (docs and behavior disagree).**
  - Advanced search (AND/OR, parentheses) became available in the API on 2025-03-06. Under it, "a space between multiple `repo`, `org`, and `user` filter qualifiers is treated as an `AND` operator" ([changelog](https://github.blog/changelog/2025-03-06-github-issues-projects-api-support-for-issues-advanced-search-and-more/)).
  - A GitHub staff member said "on Sept 4, 2025 all issues queries will use advanced search by default" ([community discussion, secondary](https://github.com/orgs/community/discussions/148716)).
  - **Observed on 2026-10-01**, that switch had *not* happened for the API. For `is:pr is:open org:cli org:github`:

    | Endpoint | Results |
    |---|---|
    | GraphQL `type: ISSUE` | 4,160 (space = OR) |
    | GraphQL `type: ISSUE_ADVANCED` | 0 (space = AND) |
    | REST default (API versions 2022-11-28 and 2026-03-10) | 4,160 |
    | REST `advanced_search=true` | 0 |

    `(org:cli OR org:github)` returned 4,160 under `ISSUE_ADVANCED` and 0 under `ISSUE`.
  - **Context (secondary source):** during 2025 the REST API attached a deprecation notice to legacy issue searches: "… is deprecated. It is scheduled to be removed on Thu, 04 Sep 2025 00:00:00 GMT" ([Azure/azure-rest-api-specs#33424](https://github.com/Azure/azure-rest-api-specs/issues/33424)). **Observed (verifier, 2026-10-01):** a legacy `/search/issues` call returned no `Deprecation`, `Sunset` or `Warning` header, and in the live schema neither `ISSUE` nor `ISSUE_ADVANCED` is marked deprecated. The switch was announced, then evidently not carried out; GitHub has published no new date that I could find. Expect it to flip without much notice.
  - **Decision-relevant:** always pin the search type explicitly. Either issue one query per org, or use `ISSUE_ADVANCED` with explicit `OR`. `ISSUE_ADVANCED` is the forward-safe choice, since it matches the announced future default.
- **Semantic and hybrid issue search** went GA on 2026-04-02 (`ISSUE_SEMANTIC`, `ISSUE_HYBRID`, rate limited to 10/min) ([changelog](https://github.blog/changelog/2026-04-02-improved-search-for-github-issues-is-now-generally-available/)). The changelog describes the GraphQL side as a `searchType` argument with `SEMANTIC`/`HYBRID`, but the live schema has no such argument; it exposes them as `SearchType` values `ISSUE_SEMANTIC`/`ISSUE_HYBRID` on the existing `type` argument (introspection, 2026-10-01). This is not needed for oversight.

### Per-org and per-repo list endpoints ("since a timestamp")

| What | REST | GraphQL | Since filter? |
|---|---|---|---|
| Repos that changed | `GET /orgs/{org}/repos?sort=pushed` ([repos REST](https://docs.github.com/en/rest/repos/repos)) | `organization.repositories(orderBy: {field: PUSHED_AT, direction: DESC})` ("last pushed to", per schema) | No, sort and stop at the last-seen time |
| Issues and PRs across an org | `GET /orgs/{org}/issues?filter=all&state=all&sort=updated&since=T` (includes PRs) ([issues REST](https://docs.github.com/en/rest/issues/issues)) | via `search` | Yes (`since`) |
| Issues in a repo | `GET /repos/{o}/{r}/issues?since=T` (includes PRs) | `issues(filterBy: {since: T})` | Yes |
| PRs in a repo | `GET /repos/{o}/{r}/pulls?state=all&sort=updated&direction=desc` ([pulls REST](https://docs.github.com/en/rest/pulls/pulls)) | `pullRequests(orderBy: {field: UPDATED_AT, direction: DESC})` | No, sort and stop |
| Reviews | per PR, `GET …/pulls/{n}/reviews`, chronological ([reviews REST](https://docs.github.com/en/rest/pulls/reviews)) | nested `reviews(last: n)` on each PR | No |
| Commits | `GET /repos/{o}/{r}/commits?since=T`, default branch unless `sha` is given ([commits REST](https://docs.github.com/en/rest/commits/commits)) | `defaultBranchRef.target.history(since: T)` | Yes |
| Releases | `GET /repos/{o}/{r}/releases` | `releases(orderBy: {field: CREATED_AT, direction: DESC})` | No, sort and stop |

- **The org issues endpoint.**
  - `filter=all` means "all issues you can see, regardless of participation or creation". The endpoint works with GitHub App user tokens and fine-grained PATs and needs no permission ([issues REST](https://docs.github.com/en/rest/issues/issues)).
  - **Observed:** it returned `404` for an org the account is not a member of, and `200` with an ETag (then `304`) for a member org. It is therefore only an option for orgs where the User is a member.
- **Commit authors.** A commit author's `user` is null "if no such user exists" for that email (GraphQL `GitActor.user`, live schema). Per-person grouping of commits will therefore have some unlinked authors.

### Webhooks are not usable in v1

- A GitHub App has "a single webhook" URL for all installations ([differences between app types](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps)). That URL would need a server, which Commander v1 does not have.
- `gh webhook forward` is "not supported for use in production environments". Only one person can forward per repo or org at a time, and org hooks need `admin:org_hook` ([webhook forwarding](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing)).
- GitHub's own advice to prefer webhooks over polling ([REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)) therefore can't apply until there is a Commander server.

## 3. Rate limits for a 50–200 repo org, and GraphQL point costs

### Documented limits

- **Primary, REST** ([REST limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)):
  - Base allowance: 5,000 requests/hour per user. This covers PATs and any GitHub App or OAuth app acting for the user.
  - Raised to 15,000/hour if the app is owned by a GitHub Enterprise Cloud org. Commander's app would not be.
  - The budget is "combined with any requests that another GitHub App or OAuth app makes on that user's behalf and any requests that the user makes with a personal access token". Commander competes with the User's `gh`, editor plugins, and other tools.
- **Primary, GraphQL** ([GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)): 5,000 points/hour per user, shared the same way; 10,000 for Enterprise Cloud-owned apps.
- **Installation tokens** scale up to 12,500/hour, but they need a server-held private key, so they don't apply here ([REST limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).
- **Secondary** ([REST limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)):
  - 100 concurrent requests, shared between REST and GraphQL.
  - 900 points/minute for REST and 2,000 points/minute for GraphQL. A REST GET counts 1 point; a GraphQL query without mutations counts 1, and with mutations 5.
  - 90 s of CPU per 60 s.
  - GitHub advises: "make requests serially instead of concurrently" ([REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)).
- **REST search:** 30 requests/minute ([REST search](https://docs.github.com/en/rest/search/search)).

### GraphQL cost model

- **Formula.** Add up the requests needed for each connection, assuming `first`/`last` is always reached, then "Divide the number by 100 and round the result to the nearest whole number". The minimum is 1.
- **Size limits.** A query is capped at 500,000 nodes, and `first`/`last` must be 1–100 ([GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)).
- **Timeouts.** After 10 s GitHub terminates the request. "If a timeout occurs for any of your API requests, additional points will be deducted from your primary rate limit for the next hour" (same source). The changelog for this change is dated 2025-07-21 ([changelog](https://github.blog/changelog/2025-07-21-including-timeouts-in-primary-rate-limits/)).
- **Resource limits (since 2025-09-01).** These cap "the execution resources a single query can consume". Expensive queries get partial data plus an error ([changelog](https://github.blog/changelog/2025-09-01-graphql-api-resource-limits/)).
- **Measuring costs.** `rateLimit(dryRun: true) { cost }` gives a query's cost without running it (live schema).

### Observed costs and timings (2026-10-01, `github` org with 566 repos used as a stand-in large org)

| Query | Cost (points) | Nodes | Result |
|---|---|---|---|
| Open work: 3 aliased `search` × `first: 50` | 1 | 150 | 200 OK |
| `organization.repositories(first: 100, orderBy: PUSHED_AT)`, scalar fields only | 1 | 100 | 200 OK, 0.84 s |
| `search(org:github updated:>=…, first: 100)` | 1 | 100 | 200 OK, 1.5 s |
| 10 aliased repos × (commits since ×50, 20 PRs × 5 reviews, 5 releases) | 2 (dry run) | 1,750 | not run |
| 25 repos × open PR/issue `totalCount` | 1 | — | 200 OK, 1.6 s |
| 25 repos × `history(since:, first: 20)` | 1 | — | 200 OK, 2.1 s |
| 100 repos × open PR/issue `totalCount` + latest release | 1 | 200 | 200 OK, **8.3 s** (close to the 10 s timeout). Verifier re-run: 6.1 s, `nodeCount` 100 |
| 100 repos × the above + `history(since:) { totalCount }` | 1 (dry run) | 200 | **502 after about 10.7 s, twice** |

**Lessons:**

- Point cost does not predict server time. A 1-point query can time out.
- The two timeouts appeared to cost about 22 points in total. This was inferred from `remaining` and is approximate; the amount is undocumented.
- Keep per-repo fan-out to roughly 25 repos per query, and avoid `totalCount` on commit history.

### Budget for a 200-repo org

- **Naive REST per-repo polling.** Four list calls per repo (commits, issues, pulls, releases) is about 800 requests per cycle. Without ETag hits, that is at most about 6 cycles/hour on the whole 5,000 budget, which leaves nothing for the User's other tools. With ETags, unchanged repos cost no *primary* budget, but 800 serial requests still take minutes per cycle.
- **Gate-then-GraphQL (recommended).**
  - Each cycle per org: 2 conditional REST calls (free when `304`), plus, only if something changed, 1–2 search points and about 1 point per 10–25 changed repos.
  - At a 5-minute cadence (12 cycles/hour) on a busy org, that is roughly 24 REST requests and 50–100 points per hour, about 1–2% of the shared budget.
  - Idle cycles cost about 0.
- **First-run backfill.** Covering the last N days for 200 repos takes about 2 points of repo listing, 8–16 points of batched per-repo detail, and search pages split into time windows that stay under 1,000 results each.

## 4. Cheapest queries for open work

**One GraphQL round trip, 1 point (Observed):**

```graphql
query {
  authored: search(type: ISSUE, query: "is:open is:pr author:@me archived:false", first: 50) { issueCount nodes { ... on PullRequest { number title url updatedAt isDraft reviewDecision repository { nameWithOwner } } } }
  reviewRequested: search(type: ISSUE, query: "is:open is:pr review-requested:@me archived:false", first: 50) { issueCount nodes { ... on PullRequest { number title url updatedAt repository { nameWithOwner } } } }
  assigned: search(type: ISSUE, query: "is:open is:issue assignee:@me archived:false", first: 50) { issueCount nodes { ... on Issue { number title url updatedAt repository { nameWithOwner } } } }
}
```

**Qualifier semantics** that decide what "open work" means ([search qualifiers](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests)):

- `review-requested:@me` includes requests to **a team the User is on**. Requested reviewers drop out of the results once they review.
- `user-review-requested:@me` covers direct requests only.
- `team-review-requested-user:USERNAME` covers team requests only.
- `review-involves:USERNAME` keeps PRs the User was asked to review, or already reviewed, in the results.
- `archived:false` excludes archived repos.
- `draft:true/false` filters drafts.
- Search scope: "If you have access to pull requests in more than 10,000 repositories, you will need to limit your search to a specific organization", so add `org:` qualifiers for very large access sets.

**REST alternatives:**

- `GET /issues?filter=assigned&state=open` and `GET /issues?filter=created&state=open` cover "all visible repositories including owned repositories, member repositories, and organization repositories". Results include PRs. These endpoints work with GitHub App user tokens and fine-grained PATs with no permissions ([issues REST](https://docs.github.com/en/rest/issues/issues)).
- They use a fixed URL, so they support ETags, and an unchanged poll is free. **Observed:** `304` responses left `x-ratelimit-remaining` unchanged on list endpoints.
- Review requests have no REST list endpoint, so they need search.
- With a GitHub App, all of these only see repos where the app is installed, plus public ones.

**Notifications** (`GET /notifications`):

- They give `reason` values such as `review_requested`, `assign` and `mention`, and are polling-friendly (`Last-Modified`, `X-Poll-Interval`).
- But the endpoint "does not work with GitHub App user access tokens, GitHub App installation access tokens, or fine-grained personal access tokens", and the docs say these endpoints "only support authentication using a personal access token (classic)" ([notifications REST](https://docs.github.com/en/rest/activity/notifications)).
- **Observed:** a GitHub CLI OAuth app token (`gho_` prefix) also got `200` from `GET /notifications`, with `X-Poll-Interval: 60`.
- So notifications are only available if Commander uses a classic PAT or an OAuth app.

## 5. Change detection without a public endpoint

- **The documented mechanism.** "Most endpoints return an `etag` header, and many endpoints return a `last-modified` header", which can be used with `if-none-match` / `if-modified-since`. "Making a conditional request does not count against your primary rate limit if a `304` response is returned and the request was made while correctly authorized with an `Authorization` header" ([REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)).
- **Poll interval.** Events and notifications also send `X-Poll-Interval`, and GitHub says "Please obey the header" ([events REST](https://docs.github.com/en/rest/activity/events), [notifications REST](https://docs.github.com/en/rest/activity/notifications)).
- **An ETag belongs to one URL**, so the URL must stay the same between polls ([RFC 9110 §8.8.3](https://www.rfc-editor.org/rfc/rfc9110#name-etag)). Two consequences:
  - A gate URL must not contain a moving `since=` value. Use `GET /orgs/{org}/issues?filter=all&state=all&sort=updated&per_page=100` and `GET /orgs/{org}/repos?sort=pushed&per_page=100` as fixed "anything new?" probes. Then fetch the delta with `since`, or with GraphQL.
  - The repos list ETag can also change for unrelated reasons, such as stars or other repo metadata in the payload. That only causes a wasted (cheap) GraphQL check, never a missed change.
- **Observed behaviour, 2026-10-01:**
  - `304` worked, and was free, on repo issues, user repos and member-org issues lists.
  - On repo events, the first conditional request returned `200` with a new ETag even though no new event was visible. Later ones returned `304`. Treat a `200` as "maybe changed" and diff, rather than trusting it.
  - `/search/issues` responses had no ETag header, although the docs list `304` as a possible status ([REST search](https://docs.github.com/en/rest/search/search)). GraphQL responses had no ETag either.
- **Unknown:** whether `304` responses count toward the *secondary* per-minute points. The docs only exempt them from the primary limit. Pace polls serially.
- **API version.** Send `X-GitHub-Api-Version: 2026-03-10`. Version `2022-11-28` is supported for at least 24 months from 2026-03-12 and remains the default ([changelog](https://github.blog/changelog/2026-03-12-rest-api-version-2026-03-10-is-now-available/)). Breaking changes relevant here: the singular `assignee` field is removed in favour of `assignees`, and `merge_commit_sha` is removed from PRs ([breaking changes](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes?apiVersion=2026-03-10)).

## Implications for the decisions

### #18 GitHub oversight summary: contents, cadence and scope controls

**Contents.** These items are cheap to collect for every repo in scope:

- Pushes and commits to the default branch, with author.
- PRs opened, updated, merged or closed.
- Reviews submitted (state and reviewer).
- Issues opened or closed.
- Releases.

Each item carries an actor, so per-repo, per-person and per-org grouping are all equally cheap. The data does not force a choice of grouping. Two caveats:

- Commits whose email maps to no GitHub user have no login. Per-person views need a fallback, such as grouping by author name.
- Pushes to non-default branches, CI status across all branches, and full comment threads are the expensive items. Leaving them out keeps every query small.

**Cadence.** Rate limits allow polling every few minutes even for 200-repo orgs, if gated by ETags. The binding constraints are elsewhere:

- The **shared** per-user budget.
- The 10 s GraphQL timeout, so a summary should be built from small batched queries.
- The 1,000-result search cap, which forces poll-often or windowed backfill.
- The 300-event/30-day events window, which means events can't be relied on after downtime.

A natural design separates **collection cadence** (frequent and incremental, stored in local SQLite) from **summary cadence** (for example, daily or on demand, built from local data with no API cost). How long Commander can be offline and still backfill depends on the source:

- Search and list endpoints can rebuild history.
- Events cannot.

**What counts as open work.** The decision should name the exact qualifiers:

- Team review requests in or out? (`review-requested` vs `user-review-requested`)
- Drafts in or out?
- Archived repos in or out?
- Assigned PRs as well as assigned issues?
- Mentions?

All the variants cost the same: 1 point together.

**Scope controls. Who chooses the orgs and repos depends on the auth decision:**

- **GitHub App.** Effective scope is three things combined: the org owner's install choice (all or selected repos), the User's own access, and Commander's picker. The picker can be filled from `/user/installations` and `/user/installations/{id}/repositories`. An org without an install needs a "request install from your org owner" flow. Some orgs now disable such requests (GA since 2026-01-12).
- **Classic PAT.** Every org and repo the User can see is available immediately. Commander's picker is the only scope control.
- **Fine-grained PAT.** The token *is* the scope: one org per token, chosen when the User creates it.

**Hard constraints the decision must respect:**

- No private key and no installation tokens in a desktop app.
- The GitHub App must be public ("Any account") for testers outside the author's org.
- Webhooks are unusable without a server.
- The Notifications API works only with classic PATs (documented) and OAuth app tokens (Observed).
- `GET /orgs/{org}/issues` is member-orgs only (Observed).
- Search syntax: pin `ISSUE` vs `ISSUE_ADVANCED` explicitly.

**Suggested spikes before building:**

1. Register a public test GitHub App with device flow. Confirm that GraphQL `search` with a user token honours install boundaries. Check whether it needs `is:issue`/`is:pr`, and whether `viewer.organizations` lists orgs without an install.
2. Check whether a GitHub App callback accepts `http://127.0.0.1:<random-port>`, if PKCE is preferred over device flow.
3. Measure which PR and review actions bump `updatedAt` in search.

## Sources

**GitHub Apps and OAuth (docs.github.com)**

- Generating a user access token for a GitHub App: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
- Refreshing user access tokens: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
- Authenticating with a GitHub App on behalf of a user: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user
- Best practices for creating a GitHub App: https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app
- Differences between GitHub Apps and OAuth apps: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps
- Making a GitHub App public or private: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private
- Registering a GitHub App: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
- About the user authorization callback URL: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url
- Choosing permissions for a GitHub App: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- Installing a GitHub App from a third party: https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party
- Requesting a GitHub App from your organization owner: https://docs.github.com/en/apps/using-github-apps/requesting-a-github-app-from-your-organization-owner
- About OAuth app access restrictions: https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions
- Scopes for OAuth apps: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
- Authorizing OAuth apps: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps

**Tokens and SSO (docs.github.com)**

- Managing your personal access tokens: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- Setting a personal access token policy for your organization: https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization
- About authentication with SAML SSO: https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-single-sign-on/about-authentication-with-single-sign-on
- Authorizing a PAT for SSO: https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-single-sign-on/authorizing-a-personal-access-token-for-use-with-single-sign-on
- Permissions required for GitHub Apps: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
- Endpoints available for GitHub App user access tokens: https://docs.github.com/en/rest/authentication/endpoints-available-for-github-app-user-access-tokens
- Permissions required for fine-grained PATs: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens

**REST API reference (docs.github.com)**

- Events: https://docs.github.com/en/rest/activity/events
- Event types: https://docs.github.com/en/rest/using-the-rest-api/github-event-types
- Notifications: https://docs.github.com/en/rest/activity/notifications
- Issues: https://docs.github.com/en/rest/issues/issues
- Repositories: https://docs.github.com/en/rest/repos/repos
- Commits: https://docs.github.com/en/rest/commits/commits
- Pull requests: https://docs.github.com/en/rest/pulls/pulls
- Reviews: https://docs.github.com/en/rest/pulls/reviews
- Organizations: https://docs.github.com/en/rest/orgs/orgs
- App installations: https://docs.github.com/en/rest/apps/installations
- Search: https://docs.github.com/en/rest/search/search
- Breaking changes for 2026-03-10: https://docs.github.com/en/rest/about-the-rest-api/breaking-changes?apiVersion=2026-03-10

**Rate limits and best practices (docs.github.com)**

- Rate limits for the REST API: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- Best practices for using the REST API: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- GraphQL rate limits and query limits: https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
- GraphQL pagination: https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api
- GraphQL schema: live introspection of `api.github.com/graphql` on 2026-10-01 (`Query.search`, `SearchType`, `RepositoryOrderField`, `IssueFilters.since`, `GitActor.user`, `Repository.pushedAt`); reference at https://docs.github.com/en/graphql/reference/queries

**Search syntax (docs.github.com)**

- Searching issues and pull requests: https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests
- Understanding the search syntax: https://docs.github.com/en/search-github/getting-started-with-searching-on-github/understanding-the-search-syntax

**Webhooks (docs.github.com)**

- Forwarding webhooks with the GitHub CLI: https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing

**GitHub CLI manual**

- gh auth token: https://cli.github.com/manual/gh_auth_token
- gh auth login: https://cli.github.com/manual/gh_auth_login

**GitHub changelog (dated)**

- 2024-11-08, Events data retention 90 to 30 days (effective 2025-01-30): https://github.blog/changelog/2024-11-08-upcoming-changes-to-data-retention-for-events-api-atom-feed-timeline-and-dashboard-feed-features/
- 2025-03-06, Issues advanced search in the API: https://github.blog/changelog/2025-03-06-github-issues-projects-api-support-for-issues-advanced-search-and-more/
- 2025-03-18, Fine-grained PATs GA: https://github.blog/changelog/2025-03-18-fine-grained-pats-are-now-generally-available/
- 2025-06-24, Security updates for apps and API access: https://github.blog/changelog/2025-06-24-security-updates-for-apps-and-api-access/
- 2025-07-14, PKCE support: https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/
- 2025-07-21, Timeouts count toward primary rate limits: https://github.blog/changelog/2025-07-21-including-timeouts-in-primary-rate-limits/
- 2025-08-08, Events API payload changes (effective 2025-10-07): https://github.blog/changelog/2025-08-08-upcoming-changes-to-github-events-api-payloads/
- 2025-09-01, GraphQL resource limits: https://github.blog/changelog/2025-09-01-graphql-api-resource-limits/
- 2025-12-22, Control who can request apps (public preview): https://github.blog/changelog/2025-12-22-control-who-can-request-apps-for-your-organization/
- 2026-01-12, Control who can request apps (generally available): https://github.blog/changelog/2026-01-12-controlling-who-can-request-apps-for-your-organization-is-now-generally-available/
- 2026-03-12, REST API version 2026-03-10: https://github.blog/changelog/2026-03-12-rest-api-version-2026-03-10-is-now-available/
- 2026-04-02, Improved (semantic) issue search GA: https://github.blog/changelog/2026-04-02-improved-search-for-github-issues-is-now-generally-available/
- 2026-08-14, OAuth app token refresh and multiple redirect URIs: https://github.blog/changelog/2026-08-14-multiple-redirect-uris-and-token-refresh-for-oauth-apps/

**Secondary sources**

- GitHub staff statement on the advanced-search default date, community discussion #148716: https://github.com/orgs/community/discussions/148716
- RFC 9110 (HTTP Semantics), ETag: https://www.rfc-editor.org/rfc/rfc9110#name-etag
- Observed results: read-only calls made by this research against `api.github.com` on 2026-10-01, using a GitHub CLI OAuth token (classic scopes). Results come from one account on one day.

## Verification

An adversarial fact-check was run on 2026-10-01. It re-opened every cited primary source (docs.github.com pages, read as Markdown through the docs API, and the github.blog changelog entries) and repeated the key live checks with the same GitHub CLI OAuth token.

**Confirmed against the primary source (wording and numbers match):**

- GitHub App user tokens:
  - Device-flow polling needs only `client_id`, `device_code` and `grant_type`, and the device code lasts 900 s.
  - `expires_in` is always 28800, and the refresh token lasts 15897600 s.
  - Refreshing needs `client_secret` "unless the user access token was generated using the device flow".
  - "Enable Device Flow", "Expire user authorization tokens" (strongly recommended) and the webhook **Active** toggle are all registration settings.
  - "Any account" vs "Only on this account".
- Private apps: install and authorize are limited to the owning org. The 2025-06-24 changelog enforces the sign-in rule.
- Installing: owners can install; repo admins only when the app requests no org permissions and no repo administration; app managers cannot. Members can request an install. The request controls (preview 2025-12-22) cover GitHub Apps and OAuth apps.
- Best-practices quotes: never ship the private key; PKCE is preferred over device flow; device-flow phishing; public clients "have to ship the client secret". PKCE is S256-only and optional (changelog 2025-07-14).
- OAuth apps:
  - Restrictions are on by default for new orgs.
  - Unapproved apps get no private org API access.
  - `repo` is full read/write.
  - Loopback `127.0.0.1` redirects may use any port.
  - Ten tokens per user/app/scope.
  - Expiring tokens and `offline_access` (changelog 2026-08-14).
- Fine-grained PATs:
  - GA on 2025-03-18, with approval on by default.
  - One owner per token, and no outside-collaborator use.
  - Default 366-day maximum lifetime.
  - Created with SSO authorization; classic PATs are authorized after creation.
- SSO: an active SSO session is needed when authorizing an OAuth app or GitHub App.
- REST limits: 5,000/h per user, shared with every app and PAT acting for that user, and 15,000 for apps owned by an Enterprise Cloud org. Installations get at most 12,500. Secondary limits are 100 concurrent requests, 900 REST and 2,000 GraphQL points per minute, and 90 s of CPU per 60 s; point values are 1 and 5.
- GraphQL limits:
  - 5,000 points/h (10,000 for Enterprise Cloud).
  - 500,000 nodes, and `first`/`last` of 1–100.
  - Cost is divided by 100 and rounded, with a minimum of 1.
  - 10 s timeout, after which "additional points will be deducted". Timeouts have counted against the primary limit since 2025-07-21; resource limits apply since 2025-09-01.
- Events:
  - 300 events and 30 days; latency "30s to 6h" is still on the page.
  - The retention cut from 90 to 30 days took effect on 2025-01-30.
  - The payload slimming of 2025-10-07 removed commit summaries and counts, and the changelog claims events are now near-immediate.
  - The org dashboard endpoint needs the organization "Events" (read) permission.
- Search:
  - 30 requests/min, and 10/min for semantic and hybrid.
  - 1,000 results per search.
  - GitHub App user tokens get a 422 without `is:issue`/`is:pull-request`.
  - `advanced_search` param; semantic search GA on 2026-04-02.
- Notifications: "only support authentication using a personal access token (classic)", and the page says they do not work with GitHub App or fine-grained tokens.
- Conditional requests: a correctly authorized `304` "does not count against your primary rate limit".
- REST version: `2026-03-10` (changelog 2026-03-12). `2022-11-28` stays the default and is supported for at least 24 months. The singular `assignee` and `merge_commit_sha` are removed.
- `GET /user/orgs` returns an empty list for fine-grained tokens. `/user/installations` returns the installations the user has "explicit permission" to access.
- `filter=all` on the org issues endpoint, `sort=pushed` on org repos, and `since`/`sha` on commits are as stated.

**Re-run live checks (verifier, 2026-10-01):**

- `GET /notifications` with the `gho_` token returned `200`, with `X-Poll-Interval: 60` and `Last-Modified`.
- An `If-None-Match` request on `/orgs/cli/repos?sort=pushed` returned `304` twice, with `x-ratelimit-remaining` unchanged.
- `/orgs/cli/issues` returned `404` for a non-member org.
- The three-search open-work query cost 1 point with `nodeCount` 150.
- Search syntax: `is:pr is:open org:cli org:github` gave 4,168 results under `ISSUE` and REST default, and 0 under `ISSUE_ADVANCED` and REST `advanced_search=true`. The parenthesised `OR` form gave the reverse. This reproduces the finding; the counts differ only because of time.
- The 100-repo `totalCount` + `latestRelease` query cost 1 point and took 6.1 s, still slow relative to the 10 s timeout.
- The live schema shows `SearchType` = `ISSUE`, `ISSUE_ADVANCED`, `ISSUE_SEMANTIC`, `ISSUE_HYBRID`, …, none deprecated. `IssueFilters.since` and `RepositoryOrderField.PUSHED_AT` exist.

**Corrected or added in place:**

- Classic PATs: orgs *can* enforce a maximum lifetime on classic PATs. The original said they have "no required expiry", which holds only at GitHub level. Updated in the comparison table and in the classic PAT section.
- App install requests: by default outside collaborators can request too, not only members. The default is "Members and outside collaborators".
- App request controls: the original called them public preview. They went **generally available on 2026-01-12** ([GA changelog](https://github.blog/changelog/2026-01-12-controlling-who-can-request-apps-for-your-organization-is-now-generally-available/)). Updated everywhere.
- OAuth apps: the refresh token lasts six months *without use*. Refreshing a device-flow token needs no client secret.
- Advanced search: added the 2025 deprecation notice ("scheduled to be removed on Thu, 04 Sep 2025", secondary source). Also added the observation that no `Deprecation`/`Sunset` header is sent today, and a recommendation to prefer `ISSUE_ADVANCED`.
- Semantic search: the changelog's GraphQL description (`searchType: SEMANTIC/HYBRID`) does not match the live schema (`type: ISSUE_SEMANTIC/ISSUE_HYBRID`). Noted.
- Org discovery spike: named `GET /user/orgs` and `GET /user/memberships/orgs` as candidates. Both are available to user access tokens with no permission. Also noted that the per-org membership endpoint needs an org permission.
- Observed-cost table: added the verifier's re-run timing.

**Could not confirm:**

- The timeouts (502s) on the 100-repo query that adds `history { totalCount }`, and the ~22 points they cost. These were not re-run, to avoid burning points; the amount of the penalty is undocumented.
- Anything that needs a registered GitHub App:
  - GraphQL `search` restrictions with a user token.
  - Org discovery without an install.
  - Loopback callbacks on a random port.
  - The behaviour of `/orgs/{org}/issues` and `organization.repositories` under install boundaries.
- Whether `304`s count toward secondary per-minute points.
- Which PR and review actions bump `updatedAt`.
- The Events latency contradiction (docs say up to 6 h, changelog says near-immediate) remains unresolved by GitHub.
