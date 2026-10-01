# Research: Linear API for Two-way sync

Research ticket #4 on the Commander wayfinder map. Researched 2026-10-01. Its answer feeds decision ticket #14, "Linear Todos and what syncs back".

Every claim cites a source. Most sources are first-party: Linear's developer docs, help docs, changelog, terms, OAuth metadata, and the `linear/linear` SDK repo. Where I probed a live endpoint myself, the text says so. Third-party sources are labelled **[secondary]**. Schema references point to `packages/sdk/src/schema.graphql` at commit `b37823b` (2026-09-29) of `github.com/linear/linear`, the published copy of the public API schema.

## Question

How can a desktop app that runs entirely on the User's machine keep the User's Linear issues in Two-way sync?

The ticket asks five things:

- **Auth.** Personal API keys vs OAuth apps (desktop flow, PKCE), scopes, and Users in more than one workspace.
- **Reads and writes.** What can be read and written: status, assignee, priority, comments, labels, cycles, projects, and creating issues.
- **Change detection without a public endpoint.** Webhooks need a URL. What are the polling options (`updatedAt` filters, pagination)? Is any sync or streaming API open to third parties?
- **Rate limits.** Request and complexity limits, and what polling every few minutes costs.
- **The official SDK.** How well it fits a desktop app.

## Short answer

- **Two-way sync works with no Commander server.**
  - Linear's public GraphQL API (`https://api.linear.app/graphql`) can read and write every property a Todo needs: status, assignee, priority, due date, estimate, labels, cycle, project, comments, and new issues.
  - Linear says this is the same API its own apps use ([Getting started](https://linear.app/developers/graphql)).
- **Auth works without a secret on the machine.**
  - Linear supports OAuth 2.0 with PKCE and no client secret, including token refresh ([OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication); [changelog, 2025-04-10](https://linear.app/changelog/2025-04-10-new-search)). A desktop app can therefore ship a public client ID and catch the redirect on a loopback (localhost) URL.
  - Personal API keys are the simple alternative ([API and Webhooks](https://linear.app/docs/api-and-webhooks)).
  - Both kinds of credential cover **one workspace each**, so each workspace is a separate Account in Commander.
- **Webhooks are out for v1.**
  - Linear requires "a publicly accessible HTTPS, non-localhost URL" ([Webhooks](https://linear.app/developers/webhooks)).
  - That leaves two client-side ways to detect changes:
    1. **Polling.** This is documented. Fetch issues with `updatedAt` greater than the last check, newest first, a page at a time. Linear discourages polling, but it is cheap here: well under 5% of the hourly quota at a 2-minute interval (see section 4).
    2. **GraphQL subscriptions over WebSocket.** Linear's changelog says "GraphQL subscriptions can now be used with the API" ([2026-03-24](https://linear.app/changelog/2026-03-24-introducing-linear-agent)). I confirmed that `wss://api.linear.app/graphql` speaks the `graphql-transport-ws` protocol. However, the developer docs and the SDK do not cover it, and a subscription has no way to resume from a point in time, so changes made while Commander was offline are lost. **Treat it as a preview-quality speed-up layered on top of polling, never a replacement.**
- **Rate limits are generous for one User.**
  - OAuth: 5,000 requests and 2,000,000 complexity points per hour.
  - API key: 2,500 requests and 3,000,000 points per hour.
  - Any single query: at most 10,000 points ([Rate limiting](https://linear.app/developers/rate-limiting)).
  - These numbers changed at least twice between December 2025 and May 2026 (archived copies of the page, section 4), so read the response headers rather than hard-coding them.
- **Linear has no built-in conflict control.**
  - `issueUpdate` takes no version number or precondition (`IssueUpdateInput`, schema). Linear applies whichever fields you send, and the last write wins.
  - Commander must detect conflicts itself. Linear gives it useful tools for this:
    - partial updates;
    - label add/remove deltas;
    - per-field change history (`IssueHistory`);
    - client-supplied UUIDs, which make creating issues and comments safe to retry.
- **The official SDK, `@linear/sdk` (TypeScript), fits a Node backend process. It does not fit a webview renderer.**
  - It has no token refresh, no subscriptions, and no offline cache.
  - It shipped nine major versions in two months.
  - Plan to write Commander's own queries, using the SDK mainly for its types and errors, or use code generation against the published schema.

## 1. Auth

### The options

| | Personal API key | OAuth app, `actor=user` (recommended shape) | OAuth app, `actor=app` |
|---|---|---|---|
| Who sets it up | The User pastes a key created in Settings > Account > Security & Access ([API and Webhooks](https://linear.app/docs/api-and-webhooks)) | The User clicks "Connect", approves in the browser, and the redirect returns to Commander | A workspace admin installs it ([Agents](https://linear.app/developers/agents)) |
| Header | `Authorization: <API_KEY>` (no `Bearer`) ([Getting started](https://linear.app/developers/graphql)) | `Authorization: Bearer <ACCESS_TOKEN>` ([OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication)) | Same as OAuth |
| Narrowing | Full access, or a subset of Read / Write / Admin / Create issues / Create comments; **can be limited to specific teams** ([API and Webhooks](https://linear.app/docs/api-and-webhooks)) | Scopes only (listed below); no team restriction is documented | Scopes, plus admin-managed team access |
| Lifetime | Long-lived until revoked | Access token valid 24 h; refresh tokens rotate ([OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication)) | Same |
| Changes appear in Linear as | The User | The User | The app |
| Request limit | 2,500/h per user, **shared by all of that user's API keys** ([Rate limiting](https://linear.app/developers/rate-limiting)) | 5,000/h per user | 5,000/h; workspace-level apps get dynamic increases |
| Can be blocked by | Admins can stop Members creating keys (Settings > Administration > API > Member API keys) ([API and Webhooks](https://linear.app/docs/api-and-webhooks)) | Third-party app approvals, "available to workspaces on any paid plan" ([Third-Party App Approvals](https://linear.app/docs/third-party-application-approvals)); the [Workspaces](https://linear.app/docs/workspaces) page still calls it an Enterprise feature, so Linear's own docs disagree | Always needs an admin |

Commander acts on the User's behalf, so `actor=app` does not fit. It also needs an admin to install it, and Linear's agent APIs that build on it are still a "Developer Preview" ([Agents](https://linear.app/developers/agents)). The real choice is between API keys and OAuth with `actor=user`.

### OAuth for a desktop app: what Linear supports

**Endpoints and flow.**
- Authorization: `GET https://linear.app/oauth/authorize` with `client_id`, `redirect_uri`, `response_type=code`, and `scope` (comma-separated). `state` is optional but recommended ([OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication)).
- Token: `POST https://api.linear.app/oauth/token` ([OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication)).
- Revoke: `POST https://api.linear.app/oauth/revoke` ([OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication)).
- Linear publishes server metadata (RFC 8414) at `https://api.linear.app/.well-known/oauth-authorization-server`. It lists `token_endpoint_auth_methods_supported: ["client_secret_post","client_secret_basic","none"]` and `code_challenge_methods_supported: ["S256"]`, and has **no** dynamic client registration endpoint ([metadata](https://api.linear.app/.well-known/oauth-authorization-server), fetched 2026-10-01).

**PKCE without a client secret.**
- On the token exchange, `client_secret` is "(optional)" when `code_verifier` is sent.
- To refresh a PKCE-issued token, "you can simply pass `client_id`" ([OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication)).
- The changelog added "support for PKCE flow for OAuth authentication without a client secret" on **2025-04-10** ([changelog](https://linear.app/changelog/2025-04-10-new-search)).
- The docs allow `plain` or `S256` for `code_challenge_method`, but the server metadata advertises only `S256`. **Use S256.**

**Refresh tokens are mandatory and rotate.**
- Announced 2025-09-18: new apps issue refresh tokens from 2025-10-01, and existing apps had until **2026-04-01** to migrate ([changelog](https://linear.app/changelog/2025-09-19-auto-apply-triage-suggestions)). The docs now say "All OAuth2 applications were migrated to the new refresh token system on April 1, 2026" ([OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication)).
- Access tokens last 24 h (`expires_in: 86399`).
- Each refresh returns a **new** refresh token. There is a 30-minute grace window during which a failed refresh request can be replayed ([OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication)).
- What this means for Commander: one process should own token refresh, and it must save the new refresh token reliably (for example, in the OS keyring) before using it.
- The docs do not state how long a refresh token lasts in total.

**Redirect URIs.**
- The docs use `http://localhost:3000/oauth/callback` as their example ([OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication)).
- The app manifest schema allows only `http`/`https` redirect URIs, 1 to 32 of them. Each "must exactly match one used by the app" ([manifest JSON Schema](https://linear.app/.well-known/oauth-app-manifest.schema.json)).
- So: no custom URL schemes such as `commander://`. Use a loopback listener on a fixed, pre-registered port, and register a few fallback ports to cover the case where one is busy.
- Whether Linear accepts any port on loopback (the RFC 8252 convention) is **not documented** by Linear. **[secondary]** One open-source project reports testing this live on 2026-09-06: Linear refused a PKCE redirect with "Invalid redirect_uri parameter for the application" when the port differed from the registered one, so it moved to a fixed port ([loncadev/baron#199](https://github.com/loncadev/baron/issues/199)). Plan for exact matching, including `localhost` vs `127.0.0.1`.

**Public vs private apps.**
- An OAuth app's `distribution` is `private` (only the workspace that created it) or `public` ("installable by other workspaces"). The default is private ([OAuth app manifests](https://linear.app/developers/oauth-app-manifests)). The manifest schema requires an `oauth.client_uri` (the developer's URL) when `distribution` is `public` ([manifest JSON Schema](https://linear.app/.well-known/oauth-app-manifest.schema.json)), so Commander needs a home page, for example the GitHub repo.
- Commander therefore needs a **public** app. Linear recommends creating it in a dedicated workspace ([OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication)).
- Being public does not require a listing in Linear's Integration Directory. The directory is reviewed, and Linear says it "generally do[es] not accept ... apps built by hobbyists" ([Integration Directory](https://linear.app/developers/integration-directory)). This matters for later monetization, not for v1.

**Creating apps needs an admin.**
- OAuth apps are created under Settings > Administration > API, and "Admin permissions in your workspace are necessary to view this page" ([API and Webhooks](https://linear.app/docs/api-and-webhooks)).
- Linear's manifest feature lets a self-hosted or open-source project link a User to a pre-filled app form ([OAuth app manifests](https://linear.app/developers/oauth-app-manifests)). But a User who is not an admin of their work workspace cannot use it there. "Each User creates their own app" is therefore a poor fit; one Commander-owned public app is the workable shape.

**Scopes.**
- User-actor scopes: `read` (always present), `write`, `issues:create`, `comments:create`, `timeSchedule:write`, and `admin` ([OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication)).
- `issues:create` is described as "Allows creating new issues and their attachments", so the link-back attachment in section 2 fits under it ([OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication)).
- Agent-oriented scopes, documented on the Agents page for apps installed with `actor=app`: `app:assignable`, `app:mentionable`, `customer:read/write`, and `initiative:read/write`. Apps using `actor=app` cannot also request `admin` ([Agents](https://linear.app/developers/agents)).
- Since **2025-12-04**, "`issueUpdate` is now allowed with the `issues:create` scope" ([changelog](https://linear.app/changelog/2025-12-04-openai-codex-agent)). That makes `read,issues:create,comments:create` a possible least-privilege set. Which `issueUpdate` fields it covers is not documented.

**Revocation.** Users can revoke an app under Settings > Account > Security & Access > Authorized applications ([Security & Access](https://linear.app/docs/security-and-access)). Commander will then get 401 errors and must ask the User to connect again.

### Users in more than one workspace

- Every credential belongs to one workspace:
  - An API key is created inside a workspace's settings ([API and Webhooks](https://linear.app/docs/api-and-webhooks)).
  - For OAuth, `prompt=consent` "can be useful if you want to give users the opportunity to connect multiple workspaces" ([OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication)).
  - Linear's own MCP docs state that "each workspace needs its own separate authentication context" ([MCP server](https://linear.app/docs/mcp)).
- Linear allows several workspaces under one login, each with its own member list ([Workspaces](https://linear.app/docs/workspaces)).
- Consequence for the domain model: a Linear **Account** in Commander is one (person, workspace) connection, keyed by `viewer.organization.id`. This differs from email, where one Account is one login.

### Recommendation for the decision

- **Primary: one Commander-owned public OAuth app.** Use `actor=user`, PKCE (S256) with no secret, a loopback redirect on fixed ports, and `prompt=consent` for each extra workspace.
- **Fallback: personal API keys.** They need no app registration, can be limited to specific teams, and work when a paid workspace's app approval is pending. Note that the key shares its request quota with the User's other API-key scripts.

## 2. What can be read and written

The API supports "full support for mutating all entities", and changes made through it "are observed in real-time by all clients" ([API and Webhooks](https://linear.app/docs/api-and-webhooks)). The table below lists what a Todo needs. It is based on the `Issue` type, `IssueCreateInput`, `IssueUpdateInput`, and the mutation list in the [schema](https://github.com/linear/linear/blob/b37823be308a42f837277671f3ded66d33d92e6c/packages/sdk/src/schema.graphql).

| Property | Read (on `Issue`) | Write | Notes |
|---|---|---|---|
| Status | `state { id name type }` | `issueUpdate(input: { stateId })` | Workflow states belong to each team. `WorkflowState.type` is one of `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`, `duplicate` (schema `WorkflowState`). "Done" must map to a team-specific state ID. `stateHistory` exposes every state change (added 2025-12-04, [changelog](https://linear.app/changelog/2025-12-04-openai-codex-agent)). |
| Assignee | `assignee` | `assigneeId` | Separate from `delegate`, which is for agent users ([Agents](https://linear.app/developers/agents)). |
| Priority | `priority`, `priorityLabel` | `priority` (0 none, 1 urgent, 2 high, 3 medium, 4 low) | |
| Due date, estimate | `dueDate`, `estimate` | `dueDate`, `estimate` | |
| Labels | `labelIds`, `labels` | `labelIds` (replace all) or **`addedLabelIds` / `removedLabelIds`** (deltas); also `issueAddLabel` / `issueRemoveLabel` | Use deltas so a concurrent label change is not overwritten. |
| Cycle, project, milestone | `cycle`, `project`, `projectMilestone` | `cycleId`, `projectId`, `projectMilestoneId` | `cycleCreate` and `projectCreate` also exist. |
| Title, description | `title`, `description` (Markdown) | `title`, `description` | A description write replaces the whole text. `IssueHistory.updatedDescription` is only a flag, with no diff. |
| Parent / sub-issues | `parent`, `children` | `parentId` | |
| Subscribers | `subscribers` | `subscriberIds`, `issueSubscribe` | |
| Comments | `comments` on the issue, or top-level `comments(filter:…)` | `commentCreate` (`issueId`, `body`, `parentId` for threads), `commentUpdate`, `commentDelete`, `commentResolve` | Comments have their own `updatedAt` and filter. |
| Create issue | — | `issueCreate(input: { teamId, title, … })` | `teamId` is required. Without `stateId`, the issue lands in the team's first Backlog state, or in Triage if Triage is on ([Getting started](https://linear.app/developers/graphql)). |
| Archive / delete | `archivedAt`, `trashed` | `issueArchive`, `issueDelete` (moves to trash), `trashed: true/null` | Archived items are hidden unless `includeArchived: true` ([Getting started](https://linear.app/developers/graphql)). Deleted issues stay restorable for 30 days, then are permanently removed ([Delete and archive issues](https://linear.app/docs/delete-archive-issues)). |
| Bulk | — | `issueBatchUpdate` (at most 50 IDs), `issueBatchCreate` | |
| Link back to Commander | `attachments` | `attachmentCreate` / `attachmentLinkURL` | The attachment URL is idempotent per issue: re-creating with the same URL updates the existing attachment ([Attachments](https://linear.app/developers/attachments)). |
| Change history | `history` (`IssueHistory`) | — | Field-level `from*`/`to*` values (state, assignee, priority, cycle, project, labels, title, due date, estimate, …) with `actor` and `createdAt`. |

Facts that matter for sync design:

- **Retries are safe for creates.** `IssueCreateInput.id` and `CommentCreateInput.id` accept "The identifier in UUID v4 format. If none is provided, the backend will generate one." Commander can create the ID while offline and retry without making duplicates.
- **Linear does not check for conflicts.** `IssueUpdateInput` has no version, `updatedAt` precondition, or ETag. Fields left out are unchanged; fields sent overwrite. Mutation responses return `lastSyncId` (schema `IssuePayload`), but no public query accepts it, so it cannot drive syncing.
- **Early edits are not logged.** "Changes made to an issue's properties in the first 3 minutes are considered part of the issue creation process, and won't be added to the activity log" ([Getting started](https://linear.app/developers/graphql)).
- **Images need auth.** Images in descriptions and comments require authentication to load ([Getting started](https://linear.app/developers/graphql)). Files live on `https://uploads.linear.app` and accept the same `Authorization` header. Alternatively, sending the request header `public-file-urls-expire-in: <seconds>` makes the API return signed file URLs that work without a header for that long, which suits rendering in a webview ([File storage authentication](https://linear.app/developers/file-storage-authentication)).
- **Who the change appears to come from.** With `actor=user` or an API key, every write, including writes the Agent makes, shows in Linear as made by the User. Changes appear as coming from the app only with `actor=app`, which needs an admin ([OAuth actor authorization](https://linear.app/developers/oauth-actor-authorization)).

## 3. Change detection without a public endpoint

### Webhooks: not usable in v1

- **Need a public URL.** The webhook consumer must be "available in a publicly accessible HTTPS, non-localhost URL". Linear retries failed deliveries after 1 minute, 1 hour, and 6 hours, and may disable a failing webhook ([Webhooks](https://linear.app/developers/webhooks)). For an OAuth app's webhook, the host "must not be a loopback host, private-network host, or `linear.app`" ([OAuth app manifests](https://linear.app/developers/oauth-app-manifests)).
- **Workspace webhooks need an admin.** "Only workspace admins, or OAuth applications with the `admin` scope, can create or read webhooks" ([Webhooks](https://linear.app/developers/webhooks)).
- **App webhooks need one central server.** An OAuth app has **one** webhook URL, and every authorizing workspace's events go to it ([Webhooks](https://linear.app/developers/webhooks); [OAuth app manifests](https://linear.app/developers/oauth-app-manifests)). A public Commander app could only use webhooks through a central relay server, which v1 rules out. Per-User tunnels would only work with per-User apps, which need admin rights.
- If Commander ever gains a server, it could receive the app's webhooks and forward them to desktops. The payloads include `updatedFrom`, the previous values of changed fields ([Webhooks](https://linear.app/developers/webhooks)).

### Polling: documented, discouraged, and cheap

- **Linear's stance.** Linear says "One thing that we especially discourage is polling the API to fetch updates" ([Rate limiting](https://linear.app/developers/rate-limiting)). Its "Fetching Updates" guidance still covers it: "If you have to poll recent changes, order results by returning recently updated issue first … Filter issues in your GraphQL request", and do not poll each issue individually ([Getting started](https://linear.app/developers/graphql)).
- **Pagination** is Relay-style cursors: `first`/`after`, then `pageInfo { hasNextPage endCursor }`. Pages default to 50. Results are ordered by `createdAt` unless you pass `orderBy: updatedAt` ([Pagination](https://linear.app/developers/pagination)). No maximum for `first` is documented for `issues` or `comments`; the 10,000-point limit per query is the practical ceiling. **[secondary]** Third-party clients cap `first` at 250 as "Linear's maximum" ([linear-cli pagination](https://pkg.go.dev/github.com/joa23/linear-cli/pkg/linear/pagination)); the only 250 cap in the schema is on `templateSearch`.
- **Filtering.** `IssueFilter.updatedAt` and `CommentFilter.updatedAt` take a `DateComparator` (`eq`, `gt`, `gte`, `lt`, …). The value can be an ISO timestamp or a duration relative to now, such as `-PT5M` (schema `DateTimeOrDuration`; [Filtering](https://linear.app/developers/filtering)). "Me" can be expressed as `assignee: { isMe: { eq: true } }` or `subscribers: { some: { isMe: { eq: true } } }` (schema `UserFilter.isMe`, `UserCollectionFilter.some`).
- **A delta poll** for each Account can be one request with two root fields:

  ```graphql
  query Delta($since: DateTimeOrDuration!, $iAfter: String, $cAfter: String) {
    issues(first: 50, after: $iAfter, includeArchived: true, orderBy: updatedAt,
           filter: { updatedAt: { gt: $since } }) {
      nodes { id identifier title description priority dueDate estimate url
              updatedAt archivedAt trashed completedAt canceledAt labelIds
              state { id type } team { id } assignee { id } project { id } cycle { id } }
      pageInfo { hasNextPage endCursor }
    }
    comments(first: 50, after: $cAfter, includeArchived: true, orderBy: updatedAt,
             filter: { updatedAt: { gt: $since } }) {
      nodes { id body createdAt updatedAt archivedAt user { id } issue { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
  ```

**Pitfalls the API does not solve for you:**

1. **Issues leaving the Todo set.** If the poll filters on "assigned to me", an issue reassigned to someone else stops matching and simply vanishes from results. Two ways around it:
   - poll a broader scope (the User's teams) and filter on the machine; or
   - add a cheap periodic query that fetches only the IDs of open Todos and compares them.
2. **Comments are separate entities.** It is not documented whether a new comment updates the issue's `updatedAt`. The schema only says `updatedAt` is "The last time at which the entity was meaningfully updated". Poll comments separately, as above.
3. **Deletions.** Archived and trashed issues show up with `includeArchived: true` (`archivedAt`, `trashed`). After 30 days in the trash, an issue is permanently removed ([Delete and archive issues](https://linear.app/docs/delete-archive-issues)) and never appears in a delta again. Admins can also skip the 30 days: `issueDelete(permanentlyDelete: true)` is "Available only to admins" (schema). Only the ID comparison in pitfall 1 catches either case. That a trashed issue still appears in an `includeArchived` delta is inferred from the schema, not tested.
4. **Watermarks.** Track the latest server `updatedAt` seen, not the local clock. Re-query a small overlap and drop duplicates by `(id, updatedAt)`. This is my design advice, not a Linear rule.

### GraphQL subscriptions: newly open, undocumented

- **Opened in the changelog, not the docs.** The 2026-03-24 changelog says: "GraphQL subscriptions can now be used with the API. Added filtering to issue created/updated GraphQL subscriptions" ([changelog](https://linear.app/changelog/2026-03-24-introducing-linear-agent)). Later entries added a `parentId` filter for issue subscriptions ([2026-04-02](https://linear.app/changelog/2026-04-02-web-forms-for-linear-asks)) and a subscription for user settings ([2026-08-13](https://linear.app/changelog/2026-08-13-team-initiatives)).
- **What the schema offers.** The `Subscription` root type has 85 fields, including:
  - `issueCreated`/`issueUpdated`/`issueArchived`/`issueUnarchived`;
  - `commentCreated`/`commentUpdated`/`commentDeleted`;
  - `issueHistoryCreated`;
  - `notificationCreated`;
  - `workflowState*`, `issueLabel*`, `cycle*`, `project*`, and `team*`.

  `issueCreated` and `issueUpdated` accept `IssueSubscriptionFilter { assigneeId, parentId, projectId, stateId, teamId }`. **No subscription field accepts a "since" or cursor argument** (schema `Subscription`, `IssueSubscriptionFilter`). The root type itself has been in the published schema since 2021 (`git log -S` on the schema file); only its availability to API users is new.
- **My unauthenticated probe on 2026-10-01** (connection only, no data):
  - `wss://api.linear.app/graphql` returned `101 Switching Protocols`, negotiated the `graphql-transport-ws` subprotocol, and answered `connection_init` with `connection_ack`.
  - A `subscribe` message without credentials closed the socket with code `4002` and "You need to authenticate to access this operation."
  - The older `graphql-ws` (subscriptions-transport-ws) subprotocol was not accepted.
- **Not documented anywhere.** The developer docs have no subscriptions page; their GraphQL section covers Getting started, Pagination, Filtering, Rate limiting, Deprecations, Webhooks, Attachments, and Managing Customers ([Getting started](https://linear.app/developers/graphql)). The SDK sends only HTTP POST requests through `fetch` and has no WebSocket client (`packages/sdk/src/graphql-client.ts`).
- **[secondary] One open-source app's experience.** SuperAgent's notes say "The bearer is supplied in the HTTP upgrade header", and its code closes and reopens the socket shortly before the access token expires. It reports that registering subscriptions in a burst got the socket closed with code `4003`, so it spaces registrations 1.5 s apart. It notes that "Messages and changes that occur while disconnected are not recovered" ([subscriptions.ts](https://github.com/SkillfulAgents/SuperAgent/blob/459874c1975dbbb9806d5a23bd680d1108738ca8/src/shared/lib/task-manager-integrations/linear/subscriptions.ts); [design notes](https://github.com/SkillfulAgents/SuperAgent/blob/459874c1975dbbb9806d5a23bd680d1108738ca8/docs/linear-agent-integration.md)). I have not verified this.
- **Running it from a webview.** Browser `WebSocket` cannot set request headers. If header authentication is the only method, the socket must run in Commander's backend process.
- **Still unknown:**
  - whether authentication also works through the `connection_init` payload;
  - limits on connections and subscriptions;
  - whether subscription events count against rate limits;
  - behaviour when the 24-hour access token expires;
  - whether an `issueUpdated` filtered by `assigneeId` fires when the issue is reassigned *away* from the User.

### Not options

- **Linear's internal sync engine.** It powers Linear's own apps ([Scaling the Linear Sync Engine, 2023-06-29](https://linear.app/now/scaling-the-linear-sync-engine)) but is not offered to third parties. Linear's terms forbid attempts to "reverse engineer … or otherwise attempt to discover … non-public APIs". They also let Linear "set and enforce limits on Customer's use of the API" and "suspend Customer's access to the API … at any time" (section 2.3) ([Terms of Service, effective 2026-06-09](https://linear.app/terms)).
- **`pushSubscriptionCreate`.** This registers Web Push, APNs, or FCM devices "for the authenticated user's current device or browser" (schema). It serves Linear's own notification apps, is tied to a session, and delivers notifications rather than data changes.
- **Linear's MCP server** (`https://mcp.linear.app/mcp`). It uses its own OAuth 2.1 with dynamic client registration ([MCP server](https://linear.app/docs/mcp); [MCP metadata](https://mcp.linear.app/.well-known/oauth-authorization-server)). It suits the Agent calling Linear as tools, but it is not a change feed.

## 4. Rate limits and what polling costs

### Current limits

Source for every row: [Rate limiting](https://linear.app/developers/rate-limiting), fetched 2026-10-01.

| Auth | Requests | Complexity | Scope |
|---|---|---|---|
| API key | 2,500 / hour | 3,000,000 points / hour | per user; "all requests by the same user share the same quota even when using different API keys" |
| OAuth app | 5,000 / hour | 2,000,000 points / hour | per user (or app user) |
| Unauthenticated | 600 / hour | 100,000 points / hour | per IP |
| Any single query | — | 10,000 points maximum, always rejected above that | — |

**How the limits behave.**
- Linear uses a leaky bucket that refills at `LIMIT_AMOUNT / LIMIT_PERIOD`.
- Some queries and mutations have lower per-endpoint limits, reported in `X-RateLimit-Endpoint-*` headers.
- When a limit is hit, Linear returns HTTP **400** (not 429) with `extensions.code: "RATELIMITED"`.
- Response headers report usage: `X-RateLimit-Requests-*`, `X-Complexity`, and `X-RateLimit-Complexity-*` ([Rate limiting](https://linear.app/developers/rate-limiting)).
- The docs do not say whether one person's quotas are shared across workspaces.

**Recent changes.** These come from archived copies of the same Linear page on the Wayback Machine:

| Archived copy | API key, requests | OAuth, requests | API key, points | OAuth, points |
|---|---|---|---|---|
| [2025-12-10](http://web.archive.org/web/20251210054039/https://linear.app/developers/rate-limiting) | 1,500 | 1,200 | 250,000 | 200,000 |
| [2026-02-12](http://web.archive.org/web/20260212002853/https://linear.app/developers/rate-limiting) | 5,000 | 5,000 | 3,000,000 in the table (the prose still said 250,000) | 2,000,000 |
| [2026-05-19](http://web.archive.org/web/20260519094055/https://linear.app/developers/rate-limiting) | 2,500 in the table (the prose still said 5,000) | 5,000 | 3,000,000 | 2,000,000 |
| Live page, 2026-10-01 | 2,500 | 5,000 | 3,000,000 | 2,000,000 |

Any changes are announced in Linear's Slack API channel ([Rate limiting](https://linear.app/developers/rate-limiting)). Read the headers instead of hard-coding the numbers.

**Running in a webview.** My CORS check on 2026-10-01: `api.linear.app` echoes back any request origin. Its `Access-Control-Expose-Headers` lists `Retry-After` but **not** `X-RateLimit-*` or `X-Complexity`. A webview can call the API but cannot read its own quota. One more reason to run the sync engine outside the renderer.

### Complexity: how it is counted, with an estimate

Linear's documented formula ([Rate limiting](https://linear.app/developers/rate-limiting)):
- each property costs 0.1;
- each object costs 1;
- a connection multiplies its children's cost by `first` (default 50);
- the total is rounded up.

Points are charged for the page size requested, not for the rows returned. An empty poll costs the same as a full one.

Estimates for the delta query in section 3, using that formula. I have not measured them; confirm with the `X-Complexity` header:

- `issues(first: 50)`: each node is 1 (the issue) + 1.4 (14 scalars) + 1.2 (`state`) + 4 × 1.1 (`team`, `assignee`, `project`, `cycle`) ≈ 8, so about **400 points**.
- `comments(first: 50)`: each node is 1 + 0.5 (5 scalars) + 1.1 (`user`) + 1.1 (`issue`) = 3.7, so about **185 points**.
- Combined, with the two `pageInfo` objects: about **590 points per request**.
- Nested connections are what get expensive. For example, `issues(first: 50) { comments(first: 50) { … } }` costs 50 × 50 × children, about 9,000 points, close to the 10,000 cap. Keep queries flat and use `labelIds` instead of `labels { … }`.

Cost per Account at that size (one combined request per poll):

| Interval | Requests/h | Points/h | Share of OAuth limits (req / pts) | Share of API-key limits (req / pts) |
|---|---|---|---|---|
| 5 min | 12 | ~7,100 | 0.2% / 0.4% | 0.5% / 0.2% |
| 2 min | 30 | ~17,700 | 0.6% / 0.9% | 1.2% / 0.6% |
| 1 min | 60 | ~35,400 | 1.2% / 1.8% | 2.4% / 1.2% |
| 30 s | 120 | ~70,800 | 2.4% / 3.5% | 4.8% / 2.4% |

**Other costs.** Fetching only the IDs of open Todos (`first: 250`, about 275 points) every 15 minutes, plus an hourly refresh of team metadata (states, labels, cycles, members), adds a few requests per hour. The first full sync is cheap too: 1,000 relevant issues is 20 pages, about 8,000 points. Writes are one request each. **Polling every 1 to 2 minutes is well within budget.** The main risk with an API key is the User's other scripts using the same quota.

## 5. The official SDK and desktop fit

**Facts.**
- `@linear/sdk` is at **97.0.0**, published 2026-09-28 ([npm](https://www.npmjs.com/package/@linear/sdk)). It is MIT-licensed TypeScript, generated from the schema ([package.json](https://github.com/linear/linear/blob/b37823be308a42f837277671f3ded66d33d92e6c/packages/sdk/package.json)).
- **ESM-only since 97.0.0.** It needs Node `^20.19.0 || >=22.12.0`, which Node 24 satisfies ([SDK CHANGELOG](https://github.com/linear/linear/blob/b37823be308a42f837277671f3ded66d33d92e6c/packages/sdk/CHANGELOG.md)).
- Its only runtime dependency is `@graphql-typed-document-node/core`. It uses `globalThis.fetch` (`graphql-client.ts`). The built `dist/index.mjs` is about 3.2 MB; `dist/` is 8.2 MB with type declarations (measured from the npm tarball).
- The developer docs list only this TypeScript SDK. For other languages, Rust included, the docs only suggest "a GraphQL client to introspect and explore the schema" ([Getting started](https://linear.app/developers/graphql)); a typed client would come from code generation against the published schema.

**What it gives you.**
- Typed models and mutations, such as `client.createIssue`, `client.updateIssue`, and `issue.comments()`.
- Connection helpers (`fetchNext`, `paginate`).
- `client.client.rawRequest(query, vars)` for custom queries. It returns the response headers, so `X-Complexity` is readable ([Advanced usage](https://linear.app/developers/advanced-usage); `graphql-client.ts`).
- Typed errors, including `RatelimitedLinearError`, which exposes `retryAfter` and the remaining-quota headers (`error.ts`).

**Where it falls short for a desktop sync engine.**
- **Too many requests by default.** Relations load lazily: `await issue.assignee` is another request ([Fetching & modifying data](https://linear.app/developers/sdk-fetching-and-modifying-data)). Linear itself advises "This applies especially if you're using our SDK … write your own custom GraphQL queries" ([Rate limiting](https://linear.app/developers/rate-limiting)).
- **No token refresh.** `LinearClient` takes a fixed `accessToken` or `apiKey` (`client.ts`). Commander must refresh tokens itself, then either swap the header with `client.client.setHeader("Authorization", "Bearer …")` (`graphql-client.ts`), rebuild the client, or pass its own request function to `LinearSdk` ([Advanced usage](https://linear.app/developers/advanced-usage)).
- **Missing pieces.** No WebSocket subscriptions, no offline cache, no sync layer.
- **Needs Node.** It reads `process.env.npm_package_name` when the client is created (`client.ts`), so a plain browser bundle needs a `process` stand-in. Combined with the hidden rate-limit headers in a webview, the SDK belongs in a Node process: Electron's main process or a Node sidecar. If the tech stack ticket picks a Rust backend (for example Tauri), the SDK drops out and the sync engine would send its own GraphQL over HTTP.
- **Frequent breaking releases.** Majors 89.0.0 through 97.0.0 shipped between 2026-07-30 and 2026-09-28 ([npm](https://www.npmjs.com/package/@linear/sdk)). Most were schema changes marked `[breaking]`, often to internal fields ([SDK CHANGELOG](https://github.com/linear/linear/blob/b37823be308a42f837277671f3ded66d33d92e6c/packages/sdk/CHANGELOG.md)). The API itself is unversioned. Breaking changes are announced and marked with `@deprecated`, and API changes appear in the changelog under an `[API]` prefix ([Deprecations](https://linear.app/developers/deprecations)). Pin an exact SDK version.

**Fit.**
- **Good:** in a Node backend, for its types, typed errors, and one-off mutations.
- **Weak:** as the sync engine itself. Commander's own small set of flat queries, sent via `rawRequest` or a typed client generated from `schema.graphql`, gives control over complexity and headers. A subscription client, if used, would be a separate `graphql-transport-ws` library.

## Implications for the decisions

### #14: Linear Todos and what syncs back

**Which Linear issues become Todos.**
- **Selectors.** The server can filter on everything plausible:
  - assigned to me (`assignee.isMe`), subscribed (`subscribers.some.isMe`), created by me, delegated to an agent;
  - team, state type (for example, exclude `completed`/`canceled`/`duplicate`), cycle, project, priority, due date, labels.

  Subscription filters are narrower: `assigneeId`, `teamId`, `projectId`, `stateId`, `parentId`.
- **Per workspace.** Credentials, and probably the Todo rules too, are per workspace. Each Linear Account is one workspace.
- **Membership needs a guard.** Whatever rule is chosen, detecting an issue *leaving* the set needs either a broader poll or the periodic ID comparison. An `assignee = me` delta does not report reassignments away from the User.

**Which edits write back.**
- **Cheap and safe:**
  - status, by mapping "done" to a team-specific `completed`-type state, with a rule for teams that have several such states, and for `canceled`;
  - assignee, priority, due date, estimate, cycle, project;
  - labels, sent as deltas;
  - new comments, and new issues (`teamId` required).
- **Risky:** editing the description, which replaces the whole text and has no merge.
- **Scopes.** `read,write` is the simple choice. `read,issues:create,comments:create` is a possible least-privilege set, since `issueUpdate` is allowed under `issues:create` from 2025-12-04. Test which fields it actually allows.
- **Attribution and the Autonomy setting.** Writes the Agent makes under the User's token show in Linear as the User's own. If Agent-made writes must be distinguishable in Linear, Commander would need to add a marker itself, such as a comment footer or an attachment, because `createAsUser` is only available with `actor=app`.

**When Commander and Linear disagree.**
- Linear will not detect conflicts: no ETag or precondition; whichever field value is written last wins. Commander has to:
  1. store the last-synced value and `updatedAt` for each issue;
  2. send only the fields the User changed;
  3. re-read the issue just before writing, or right after a failed write;
  4. use `IssueHistory` (with `actor`, `createdAt`, and `from*`/`to*`) to see who changed a field and when.

  Then apply whatever policy #14 chooses for conflicts on the same field: Linear wins, Commander wins, or ask the User.
- **Offline edits** can be queued safely. Creates carry UUIDs generated on the machine, and attachments are idempotent by URL.
- **Deletions** arrive as `archivedAt`/`trashed` changes for 30 days. After that the issue simply disappears, and only the ID comparison notices.
- **Speed of showing Linear's changes.** It equals the polling interval (1 to 2 minutes is affordable), or near real time if subscriptions prove reliable. A catch-up poll is still needed at launch, after sleep or wake, and after a dropped connection.

### Cross-cutting (for the domain glossary and the auth choice)

- **A Linear Account is a workspace connection**, not a login. CONTEXT.md's "Account" definition may need a note for Linear.
- **Each tester connects once per workspace.** Corporate workspaces on paid plans may require admin approval of the Commander app. Personal API keys are the escape hatch, unless the admin has disabled member keys.

### Spikes worth running before #14 is closed

1. **Authenticated subscriptions.** Test whether the token works as an upgrade header and/or in the `connection_init` payload. Check whether filtering by `assigneeId` catches reassignment away from the User, how the socket behaves when the token expires after 24 h, and what errors it gives when too many subscriptions are opened (the reported `4003`).
2. **OAuth loopback redirect.** Check whether a redirect URI with any port is accepted, or only an exact registered port (a secondary report says exact only).
3. **Real costs.** Measure `X-Complexity` on the real delta query, and check whether creating a comment updates `Issue.updatedAt`.

## Not answered or not verified

- **Subscriptions.** How authentication works, the limits on connections and subscriptions, how events are billed against rate limits, and whether delivery is guaranteed. None of it is documented; it needs an authenticated test, which I did not run because I had no credentials.
- **Loopback redirects with any port.** Not documented by Linear. One secondary report says the port must match exactly; confirm in the spike.
- **Refresh token lifetime.** Not documented.
- **Maximum page size (`first`).** Not documented; the 10,000-point cap per query is the practical bound. Third-party clients assume 250.
- **Whether quotas are shared across workspaces** for the same person. Not documented.
- **Which `issueUpdate` fields** the `issues:create` scope permits. Not documented.
- **What counts as "meaningfully updated"** for `updatedAt`. Not defined; in particular, whether comments update it.

## Sources

**Linear developer docs** (fetched 2026-10-01)
- Getting started (GraphQL): https://linear.app/developers/graphql
- Pagination: https://linear.app/developers/pagination
- Filtering: https://linear.app/developers/filtering
- Rate limiting: https://linear.app/developers/rate-limiting
- Deprecations: https://linear.app/developers/deprecations
- Webhooks: https://linear.app/developers/webhooks
- Attachments: https://linear.app/developers/attachments
- OAuth 2.0 authentication: https://linear.app/developers/oauth-2-0-authentication
- OAuth actor authorization: https://linear.app/developers/oauth-actor-authorization
- OAuth application manifests: https://linear.app/developers/oauth-app-manifests
- OAuth app manifest JSON Schema: https://linear.app/.well-known/oauth-app-manifest.schema.json
- Agents, Getting Started (Developer Preview): https://linear.app/developers/agents
- Integration Directory: https://linear.app/developers/integration-directory
- TypeScript SDK, Getting started: https://linear.app/developers/sdk
- SDK, Fetching & modifying data: https://linear.app/developers/sdk-fetching-and-modifying-data
- SDK, Advanced usage: https://linear.app/developers/advanced-usage
- File storage authentication: https://linear.app/developers/file-storage-authentication

**Linear help docs and policy** (fetched 2026-10-01)
- API and Webhooks: https://linear.app/docs/api-and-webhooks
- Third-Party App Approvals: https://linear.app/docs/third-party-application-approvals
- Security & Access: https://linear.app/docs/security-and-access
- Workspaces: https://linear.app/docs/workspaces
- Delete and archive issues: https://linear.app/docs/delete-archive-issues
- MCP server: https://linear.app/docs/mcp
- Terms of Service (effective 2026-06-09): https://linear.app/terms
- Scaling the Linear Sync Engine (2023-06-29): https://linear.app/now/scaling-the-linear-sync-engine

**Linear changelog**
- 2025-04-10, granular API key permissions; PKCE without client secret: https://linear.app/changelog/2025-04-10-new-search
- 2025-09-18, short-lived tokens and refresh tokens; `client_credentials`: https://linear.app/changelog/2025-09-19-auto-apply-triage-suggestions
- 2025-12-04, `issueUpdate` allowed with `issues:create`; `Issue.stateHistory`: https://linear.app/changelog/2025-12-04-openai-codex-agent
- 2026-03-24, GraphQL subscriptions usable with the API; issue subscription filters: https://linear.app/changelog/2026-03-24-introducing-linear-agent
- 2026-04-02, `parentId` filter for issue subscriptions: https://linear.app/changelog/2026-04-02-web-forms-for-linear-asks
- 2026-08-13, user settings subscription: https://linear.app/changelog/2026-08-13-team-initiatives
- 2022-08-04, rate limits enforced for personal API keys: https://linear.app/changelog/2022-08-04-project-updates

**Live endpoints** (my own probes, 2026-10-01, unauthenticated)
- OAuth server metadata: https://api.linear.app/.well-known/oauth-authorization-server
- MCP OAuth metadata: https://mcp.linear.app/.well-known/oauth-authorization-server
- `wss://api.linear.app/graphql` WebSocket handshake (`graphql-transport-ws`: `connection_ack`, then close `4002` when unauthenticated)
- CORS preflight to `https://api.linear.app/graphql` (any origin echoed back; rate-limit headers not exposed)

**Source code and packages**
- Public schema (pinned): https://github.com/linear/linear/blob/b37823be308a42f837277671f3ded66d33d92e6c/packages/sdk/src/schema.graphql
- SDK package.json: https://github.com/linear/linear/blob/b37823be308a42f837277671f3ded66d33d92e6c/packages/sdk/package.json
- SDK CHANGELOG: https://github.com/linear/linear/blob/b37823be308a42f837277671f3ded66d33d92e6c/packages/sdk/CHANGELOG.md
- SDK client.ts: https://github.com/linear/linear/blob/b37823be308a42f837277671f3ded66d33d92e6c/packages/sdk/src/client.ts
- SDK graphql-client.ts: https://github.com/linear/linear/blob/b37823be308a42f837277671f3ded66d33d92e6c/packages/sdk/src/graphql-client.ts
- SDK error.ts: https://github.com/linear/linear/blob/b37823be308a42f837277671f3ded66d33d92e6c/packages/sdk/src/error.ts
- npm package and release dates: https://www.npmjs.com/package/@linear/sdk

**Archived snapshots** (Wayback Machine copies of a first-party page)
- Rate limiting, 2025-12-10: http://web.archive.org/web/20251210054039/https://linear.app/developers/rate-limiting
- Rate limiting, 2026-02-12: http://web.archive.org/web/20260212002853/https://linear.app/developers/rate-limiting
- Rate limiting, 2026-05-19: http://web.archive.org/web/20260519094055/https://linear.app/developers/rate-limiting

**[secondary] Third-party reports** (unverified)
- loncadev/baron issue #199 (2026-09-06), exact redirect-port matching: https://github.com/loncadev/baron/issues/199
- linear-cli pagination package, 250 page cap: https://pkg.go.dev/github.com/joa23/linear-cli/pkg/linear/pagination
- SuperAgent subscriptions.ts: https://github.com/SkillfulAgents/SuperAgent/blob/459874c1975dbbb9806d5a23bd680d1108738ca8/src/shared/lib/task-manager-integrations/linear/subscriptions.ts
- SuperAgent design notes: https://github.com/SkillfulAgents/SuperAgent/blob/459874c1975dbbb9806d5a23bd680d1108738ca8/docs/linear-agent-integration.md

## Verification

Adversarial fact-check on 2026-10-01. I re-fetched every first-party page listed above and re-ran the live probes.

**Checked and confirmed as written**
- Rate limits on the live page: API key 2,500 requests and 3,000,000 points per hour; OAuth 5,000 and 2,000,000; unauthenticated 600 and 100,000; 10,000 points per query; HTTP 400 with `RATELIMITED`; leaky bucket; endpoint headers; the complexity formula and its worked examples. The three Wayback snapshots match the history table.
- OAuth: PKCE with `client_secret` "(optional)"; refresh with only `client_id` for PKCE tokens; `expires_in: 86399`; a new refresh token on every refresh; the 30-minute replay grace; "All OAuth2 applications were migrated to the new refresh token system on April 1, 2026"; `prompt=consent` wording; the scope list; and the recommendation to manage the app from a dedicated workspace.
- OAuth metadata: `none` auth method, S256 only, no `registration_endpoint`. Manifest schema: `http(s)` redirect URIs only, 1 to 32 of them, exact match.
- Changelog entries: 2025-04-10 (PKCE without a secret; granular API keys), 2025-09-18 (24-hour tokens; new apps from 2025-10-01; deadline 2026-04-01), 2025-12-04 (`issueUpdate` under `issues:create`; `stateHistory`), 2026-03-24 ("GraphQL subscriptions can now be used with the API"), 2026-04-02 (`parentId` filter) and 2026-08-13 (user settings subscription).
- Webhooks: the public-URL rule, admin-only creation, one URL per OAuth app, the retry schedule and `updatedFrom`. The app manifest page bans loopback and private-network hosts.
- Schema at `b37823b` (identical to `master` on 2026-10-01): `Subscription` has 85 fields and none takes a cursor or "since" argument; `IssueSubscriptionFilter` has the five fields listed; `IssueUpdateInput` has no version or precondition field and does have `addedLabelIds`/`removedLabelIds`; `IssueCreateInput.id` and `CommentCreateInput.id` take a client UUID; `issueBatchUpdate` allows at most 50 IDs; `DateComparator` takes `DateTimeOrDuration`; `createAsUser` only works with `actor=app`.
- Live probes, re-run: `wss://api.linear.app/graphql` negotiates `graphql-transport-ws`, sends `connection_ack`, then closes with `4002` on an unauthenticated `subscribe`; `graphql-ws` fails. A bogus token in the `connection_init` payload produced the same `4002`, so the probe cannot tell whether payload auth is supported. CORS echoes any origin (including `tauri://localhost`) and exposes `Retry-After` but no rate-limit headers.
- SDK: version 97.0.0 published 2026-09-28; ESM-only (CHANGELOG); engines `^20.19.0 || >=22.12.0`; MIT; a single dependency; `dist/index.mjs` 3.2 MB and `dist/` 8.2 MB; majors 89 to 97 between 2026-07-30 and 2026-09-28; `process.env.npm_package_name` in `client.ts`; `RatelimitedLinearError` fields.
- Help docs: member API key controls and team-limited keys; app creation needs an admin; 30-day restore window for deleted issues; several workspaces under one login; MCP's "separate authentication context" for each workspace; the Integration Directory "hobbyists" line; Terms section 2.3 and the ban on discovering "non-public APIs" (effective 2026-06-09); Agents still in "Developer Preview".
- Cost arithmetic: the delta query works out to about 588 points (400 + 185 + 2.4), and the table percentages follow from it.

**Corrected or added**
- "Changed twice in the past ten months" became "at least twice between December 2025 and May 2026": the snapshots are sparse, so there may have been more changes.
- The `customer:*` and `initiative:*` scopes are documented for agents, not stated as "app-actor-only". Reworded, and added that `actor=app` cannot request `admin`.
- Added that `issues:create` also covers attachments, so the link-back attachment fits the least-privilege scope set.
- Added that public apps must give an `oauth.client_uri` (manifest schema).
- Added a secondary report (2026-09-06) that Linear requires the exact registered redirect port.
- Third-party app approvals: Linear's docs disagree on whether this is any paid plan or Enterprise only. Flagged it.
- Added signed file URLs (the `public-file-urls-expire-in` header) for showing images.
- Deletions: admins can delete permanently at once (`permanentlyDelete`), skipping the 30-day trash.
- Corrected the SuperAgent quote to its exact wording, and noted that it reconnects before the token expires.
- SDK: `client.client.setHeader` can swap a refreshed token without rebuilding the client. The codegen claim was cited to a page that does not say it; now cited correctly. Noted that a Rust backend would not use the SDK.
- Page size: added a secondary claim of a 250 cap, and noted that the schema's only documented 250 cap is on `templateSearch`.
- The 2026-02-12 snapshot's prose still said 250,000 points while its table said 3,000,000.

**Could not confirm**
- Anything about authenticated subscriptions: how authentication works, limits, rate-limit billing, behaviour when the token expires. No credentials were available.
- Redirect-port matching (secondary evidence only), refresh-token lifetime, the maximum `first`, whether quotas are shared across workspaces, which fields `issues:create` allows in `issueUpdate`, and whether comments change `Issue.updatedAt`. Each still needs a test with real credentials.
- That `await issue.assignee` triggers a separate request comes from the SDK's documented lazy-loading pattern (`await comment.user`), not from an explicit statement in the docs.

