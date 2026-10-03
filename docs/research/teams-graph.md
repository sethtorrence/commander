# Microsoft Teams through Microsoft Graph for a desktop app

Researched 2026-10-03 for [issue #33](https://github.com/sethtorrence/commander/issues/33). All claims link to Microsoft Learn or to Microsoft's own docs source repo ([microsoftgraph/microsoft-graph-docs-contrib](https://github.com/microsoftgraph/microsoft-graph-docs-contrib)), which is the source for the Learn pages.

## Question

How can Commander, a desktop app on the User's machine with no server, read and act on Microsoft Teams through Microsoft Graph, using the author's existing single-tenant public-client app in his work tenant (delegated sign-in, localhost redirect)? Specifically: which permissions are needed and who must consent; how to detect changes without a public endpoint; what is readable; what can be written (including read state); and what protected, metered, licensing or policy limits apply.

## Short answer

- **1:1, group and meeting chats work with delegated permissions that need no admin consent**: `Chat.Read` / `Chat.ReadWrite` to read, `ChatMessage.Send` to reply, `Chat.ReadWrite` to mark a chat read or unread. **Channel messages need `ChannelMessage.Read.All`, which needs admin consent.** Sending a channel reply (`ChannelMessage.Send`) does not.
- **One catch on consent**: the "Let Microsoft manage your consent settings" policy, the default for new tenants since July 2025, blocks users from consenting to `Chat.Read` and `Chat.ReadWrite` (and to `Mail.ReadWrite` and `Calendars.ReadWrite`). The author could consent to Mail and Calendars himself, so his tenant is probably not on that policy, and Chat will likely behave the same. That needs testing.
- **There is no delegated delta query for Teams messages.** The only chat-message delta (`/users/{id}/chats/getAllMessages/delta`) is application-only. Channel-message delta was dropped from the v1.0 docs on 2024-09-26. Change notifications do work with delegated permissions, but they need a public HTTPS webhook or Azure Event Hubs/Event Grid, which a serverless desktop app doesn't have.
- **So Commander has to poll**: list chats with `lastMessagePreview`, then fetch messages only from chats that changed, using a `lastModifiedDateTime` filter. But Microsoft's Teams docs say polling a resource for changes is allowed **once per day**, and that apps that break this violate the API Terms of Use. A 15-minute poller is a compliance risk that needs a decision (see Implications).
- **Read state**: chats expose `viewpoint.lastMessageReadDateTime`, and there are `markChatReadForUser` / `markChatUnreadForUser`. **Channels have no read-state API.**
- **Restrictions are mostly gone for this use**: the "protected API" approval process was deprecated on 2023-05-18 and only ever applied to application permissions. Teams export APIs stopped being metered on 2025-08-25, and the `model` parameter has been ignored since then. The metered APIs were application-only anyway. No extra licence is needed for delegated chat or channel reads and writes.

## 1. Permissions

All delegated (work or school account). "Admin consent" is the `AdminConsentRequired` flag in the [permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference). The last column shows whether the [Microsoft-managed user consent policy](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies#microsoft-recommended-user-consent-policy) lets users consent to it.

| Need | API | Least-privileged delegated permission | Admin consent | User-consentable under Microsoft-managed policy |
|---|---|---|---|---|
| List my chats (with members, last-message preview, read viewpoint) | [GET /me/chats](https://learn.microsoft.com/en-us/graph/api/chat-list?view=graph-rest-1.0) | `Chat.ReadBasic` (`Chat.Read` for previews of message content) | No | `Chat.ReadBasic` yes, `Chat.Read` **no** |
| List chat members | [GET /chats/{id}/members](https://learn.microsoft.com/en-us/graph/api/chat-list-members?view=graph-rest-1.0) | `Chat.ReadBasic` | No | Yes |
| Read messages in a 1:1, group or meeting chat | [GET /chats/{id}/messages](https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0), [GET message](https://learn.microsoft.com/en-us/graph/api/chatmessage-get?view=graph-rest-1.0) | `Chat.Read` | No | **No** |
| Read inline images in chat messages | [hosted contents](https://learn.microsoft.com/en-us/graph/api/chatmessage-list-hostedcontents?view=graph-rest-1.0) | `Chat.Read` (chat), `ChannelMessage.Read.All` (channel) | No / Yes | No |
| Send a chat message or reply | [POST /chats/{id}/messages](https://learn.microsoft.com/en-us/graph/api/chat-post-messages?view=graph-rest-1.0) | `ChatMessage.Send` | No | Yes |
| Mark a chat read or unread | [markChatReadForUser](https://learn.microsoft.com/en-us/graph/api/chat-markchatreadforuser?view=graph-rest-1.0), [markChatUnreadForUser](https://learn.microsoft.com/en-us/graph/api/chat-markchatunreadforuser?view=graph-rest-1.0) | `Chat.ReadWrite` (only option; app-only not supported) | No | **No** |
| React to a chat message | [setReaction](https://learn.microsoft.com/en-us/graph/api/chatmessage-setreaction?view=graph-rest-1.0) | `Chat.ReadWrite`, `ChatMessage.Send` | No | `ChatMessage.Send` yes |
| List my teams and their channels | [joinedTeams](https://learn.microsoft.com/en-us/graph/api/user-list-joinedteams?view=graph-rest-1.0), [list channels](https://learn.microsoft.com/en-us/graph/api/channel-list?view=graph-rest-1.0) | `Team.ReadBasic.All`, `Channel.ReadBasic.All` | No | Yes |
| Read channel posts and replies | [list channel messages](https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0), [list replies](https://learn.microsoft.com/en-us/graph/api/chatmessage-list-replies?view=graph-rest-1.0) | `ChannelMessage.Read.All` | **Yes** | n/a (admin) |
| Reply in a channel thread | [POST .../messages/{id}/replies](https://learn.microsoft.com/en-us/graph/api/chatmessage-post-replies?view=graph-rest-1.0) | `ChannelMessage.Send` | No | Yes |
| List channel members | [channel members](https://learn.microsoft.com/en-us/graph/api/channel-list-members?view=graph-rest-1.0) | `ChannelMember.Read.All` | **Yes** | n/a |
| Search my Teams messages (mentions, unread) | [search API, chatMessage](https://learn.microsoft.com/en-us/graph/search-concept-chat-messages) | `Chat.Read`, `Chat.ReadWrite` or `ChannelMessage.Read.All` ([overview](https://learn.microsoft.com/en-us/graph/api/resources/search-api-overview?view=graph-rest-1.0)) | No for Chat.* | No |
| Meeting details for a meeting chat | [GET onlineMeeting](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-get?view=graph-rest-1.0) | `OnlineMeetings.Read` | No | **No** |
| Open a file attached to a message | the file lives in SharePoint/OneDrive ([attachment](https://learn.microsoft.com/en-us/graph/api/resources/chatmessageattachment?view=graph-rest-1.0)) | `Files.Read.All` | No (delegated) | **No** |

Notes:

- `ChatMember.Read` needs admin consent, but you don't need it: `Chat.ReadBasic` is the least-privileged permission for listing chat members ([list chat members](https://learn.microsoft.com/en-us/graph/api/chat-list-members?view=graph-rest-1.0)).
- The Microsoft-managed policy also excludes `Mail.ReadWrite` and `Calendars.ReadWrite` ([source](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies#microsoft-recommended-user-consent-policy)). The author was able to consent to those himself (issue background), so his tenant almost certainly uses a different policy, such as `microsoft-user-default-legacy` ("allow user consent for apps") or `microsoft-user-default-low` with "apps registered in your tenant" ([configure user consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent)). Expect the same result for `Chat.*`, but test it.
- Resource-specific consent (`ChannelMessage.Read.Group`, `ChatMessage.Read.Chat`) is application-only, for Teams apps installed in a team or chat ([list channel messages](https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0)). It doesn't help a delegated desktop client avoid admin consent for channels.

## 2. Change detection without a public endpoint

**Delta query**

- Only one Teams message delta exists, `GET /users/{id}/chats/getAllMessages/delta`, and its delegated support is **"Not supported"**. It requires application `Chat.Read.All` ([chats-getAllMessages: delta, v1.0](https://learn.microsoft.com/en-us/graph/api/chatmessage-delta?view=graph-rest-1.0)).
- **Recently changed:** until 2024-09-26 the same doc page described channel-message delta, `GET /teams/{id}/channels/{id}/messages/delta`, with delegated `ChannelMessage.Read.All`. Commit [19e966ae13](https://github.com/microsoftgraph/microsoft-graph-docs-contrib/commit/19e966ae13) ("chat:getAllMessages delta APi change doc") removed that page from v1.0 and replaced it, and the October 2024 what's-new says the method was "updated ... to use a new endpoint" for chats ([what's new history, Oct 2024](https://learn.microsoft.com/en-us/graph/whats-new-earlier)). The [chatMessage resource](https://learn.microsoft.com/en-us/graph/api/resources/chatmessage?view=graph-rest-1.0) no longer lists any channel delta method. Treat channel delta as gone. Whether the old URL still answers is untested.
- The [delta query overview](https://learn.microsoft.com/en-us/graph/delta-query-overview) lists `chatMessage` only through that chats delta function.

**Change notifications (push)**

- Delegated subscriptions are supported for `/users/{id}/chats/getAllMessages` (`Chat.Read`), `/chats/{id}/messages` (`Chat.Read`) and `/teams/{id}/channels/{id}/messages` (`ChannelMessage.Read.All`). They support `$filter` on mentions of a given user and `$search` ([Teams chatMessage notifications](https://learn.microsoft.com/en-us/graph/teams-changenotifications-chatmessage)). The tenant-wide resources are application-only.
- Delivery needs "a publicly accessible, HTTPS-secured endpoint" that answers validation within 10 seconds and notifications within 3 seconds ([webhooks](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks)). The only alternative is Azure Event Hubs or Event Grid, which needs an event hub plus a Key Vault or an RBAC role in an Azure subscription ([Event Hubs delivery](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-event-hubs)). Subscriptions longer than 1 hour also need a `lifecycleNotificationUrl` ([Teams chatMessage notifications](https://learn.microsoft.com/en-us/graph/teams-changenotifications-chatmessage)). None of this fits "no server" unless Commander takes on an Azure dependency.

**Polling: the only serverless option**

- Cheap change probe: `GET /me/chats?$expand=lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc&$top=50`. Comparing `lastMessagePreview.createdDateTime` with `viewpoint.lastMessageReadDateTime` "allows the caller to determine whether the user has read all messages in a chat" ([list chats](https://learn.microsoft.com/en-us/graph/api/chat-list?view=graph-rest-1.0)). `$expand=members` returns at most 25 members per chat.
- Per changed chat: `GET /chats/{id}/messages?$orderby=lastModifiedDateTime desc&$filter=lastModifiedDateTime gt {cursor}`, `$top` up to 50, descending order only ([list messages in a chat](https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0)). `lastModifiedDateTime` also changes when a reaction is added or removed ([chatMessage](https://learn.microsoft.com/en-us/graph/api/resources/chatmessage?view=graph-rest-1.0)). The preview only tracks new messages, though, so edits and reactions in quiet chats are missed unless Commander re-polls those chats.
- Channels (admin consent): `GET /teams/{id}/channels/{id}/messages` returns root posts sorted by the last change in the whole reply chain, with `$top` up to 50 and `$expand=replies`. **It has no `$filter`** ([list channel messages](https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0)), so Commander reads the first page and stops at its cursor.
- Mentions and unread across everything in one call: the search API accepts KQL `IsMentioned:true`, `IsRead:false`, `sent>` and `from:`. But results come back by relevance or date with no custom sort, `total` is only the page count, and only a few properties are returned ([search Teams messages](https://learn.microsoft.com/en-us/graph/search-concept-chat-messages)).

**Throttling** ([Teams service limits](https://learn.microsoft.com/en-us/graph/throttling-limits#microsoft-teams-service-limits)): GET chat or channel message 20 rps per app per tenant; **1 request per second per app per tenant on any single chat or channel**; List chats or Get chat 5 rps per user; 4 rps per app on one team; POST message 1 rps per user per chat or channel. At a 15-minute interval, Commander's volume is far below these limits.

**Polling policy (the real constraint).** The Teams API overview says: "If your app polls to see whether a resource has changed, you can only do that once per day ... If you need to hear about changes more frequently than that, you should create a subscription". It adds that GETting a resource each time the user visits or refreshes is fine, "but it isn't okay to GET /me/joinedTeams in a loop every 30 seconds". Apps that don't comply are "in violation of the Microsoft APIs Terms of Use", which "may result in additional throttling or the suspension or termination" of access. When polling for messages, "you must specify a date range where supported" ([Polling requirements](https://learn.microsoft.com/en-us/graph/api/resources/teams-api-overview?view=graph-rest-1.0#polling-requirements), page updated 2024-11-21).

## 3. What's readable

- **Body**: `body.contentType` is `text` or `html`, and "always in HTML if the chat message contains a chatMessageMention". Inline images are referenced as `hostedContents/.../$value` URLs that you fetch with the same token ([chatMessage](https://learn.microsoft.com/en-us/graph/api/resources/chatmessage?view=graph-rest-1.0), [list messages example](https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0)). A beta `chatMessageBody` type that adds `markdown` arrived in June 2026 and is preview only ([what's new history](https://learn.microsoft.com/en-us/graph/whats-new-earlier)).
- **Mentions**: `mentions[]` with `id` (matching `<at id="n">` in the body), `mentionText`, and `mentioned` (user, application, team, channel, chat or tag) ([chatMessageMention](https://learn.microsoft.com/en-us/graph/api/resources/chatmessagemention?view=graph-rest-1.0)). So "mentions me" is a local check against the signed-in user's id.
- **Replies**: in channels, `replyToId` points to the root post and replies come from `/replies` or `$expand=replies`. In chats there's no threading: `replyToId` "only applies to chat messages in channels" ([chatMessage](https://learn.microsoft.com/en-us/graph/api/resources/chatmessage?view=graph-rest-1.0)).
- **Reactions**: `reactions[]` with `reactionType` (Unicode or legacy names, or `custom`), `displayName`, `user` and `createdDateTime` ([chatMessageReaction](https://learn.microsoft.com/en-us/graph/api/resources/chatmessagereaction?view=graph-rest-1.0)).
- **Attachments**: `attachments[]` with `contentType` `reference` (a link to a file, `contentUrl` pointing at SharePoint/OneDrive), `forwardedMessageReference`, or cards and code snippets ([chatMessageAttachment](https://learn.microsoft.com/en-us/graph/api/resources/chatmessageattachment?view=graph-rest-1.0)). Downloading the file is a Files API call, not a Teams one.
- **System events**: `messageType` `systemEventMessage` with `eventDetail` (member added, chat renamed and so on). Send `Prefer: include-unknown-enum-members` to get it instead of `unknownFutureValue` ([list messages in a chat](https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0)).
- **Meeting chats**: `chatType` is `oneOnOne`, `group` or `meeting`, and `onlineMeetingInfo` is set for meeting chats ([chat](https://learn.microsoft.com/en-us/graph/api/resources/chat?view=graph-rest-1.0)). They come back from List chats and are read like any other chat.
- **Who's in a chat (Person matching)**: members are `aadUserConversationMember` with `userId`, `email`, `displayName` and `tenantId` ([aadUserConversationMember](https://learn.microsoft.com/en-us/graph/api/resources/aaduserconversationmember?view=graph-rest-1.0)). Senders carry `from.user.id`, `displayName`, `userIdentityType` and, on newer payloads, `tenantId`. Matching by email links Teams senders to Outlook correspondents.
- **Deep links**: `webUrl` on chats and channel messages opens the item in Teams. It is `null` on chat messages in the examples ([list chats](https://learn.microsoft.com/en-us/graph/api/chat-list?view=graph-rest-1.0), [list channel messages](https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0)).

## 4. Writing

- **Chat reply**: `POST /chats/{id}/messages` with `ChatMessage.Send`. It can't create a new chat. Microsoft notes that using Teams "as a log file" violates the terms ([send message in chat](https://learn.microsoft.com/en-us/graph/api/chat-post-messages?view=graph-rest-1.0)). Chat replies don't thread; [replyWithQuote](https://learn.microsoft.com/en-us/graph/api/resources/chatmessage?view=graph-rest-1.0) is the closest thing.
- **Channel reply**: `POST /teams/{t}/channels/{c}/messages/{m}/replies` with `ChannelMessage.Send` ([reply in channel](https://learn.microsoft.com/en-us/graph/api/chatmessage-post-replies?view=graph-rest-1.0)). Without admin-consented `ChannelMessage.Read.All`, Commander could send but not read the thread.
- **Read state**: `POST /chats/{id}/markChatReadForUser` and `markChatUnreadForUser`, delegated `Chat.ReadWrite` only ([read](https://learn.microsoft.com/en-us/graph/api/chat-markchatreadforuser?view=graph-rest-1.0), [unread](https://learn.microsoft.com/en-us/graph/api/chat-markchatunreadforuser?view=graph-rest-1.0)). This marks the whole chat, not one message. The docs tree has no channel or channel-message read-state API (searched [microsoft-graph-docs-contrib](https://github.com/microsoftgraph/microsoft-graph-docs-contrib) for `markread`/`unread`: chat-only).
- **Reactions**: `setReaction` / `unsetReaction` (`ChannelMessage.Send` for channels; `Chat.ReadWrite` or `ChatMessage.Send` for chats) ([setReaction](https://learn.microsoft.com/en-us/graph/api/chatmessage-setreaction?view=graph-rest-1.0)).

## 5. Restrictions

- **Protected APIs: deprecated.** "Starting May 18, 2023, the protected API approval process has been deprecated." The list only ever covered APIs using application permissions. The page was deleted from the docs on 2023-06-26 ([last version of teams-protected-apis.md](https://github.com/microsoftgraph/microsoft-graph-docs-contrib/blob/ce79b319c5/concepts/teams-protected-apis.md), [deletion commit 05a7c71e17](https://github.com/microsoftgraph/microsoft-graph-docs-contrib/commit/05a7c71e17)).
- **Metered Teams APIs: no longer metered.** "Starting August 25, 2025, the Teams APIs listed in this article are no longer metered, and no billing configuration is required ... the `model` query parameter is no longer required and is ignored when supplied. License enforcement isn't applicable unless explicitly specified" ([teams-licenses.md source](https://github.com/microsoftgraph/microsoft-graph-docs-contrib/blob/main/concepts/teams-licenses.md)). The April 2026 what's-new records that the `model` parameters and payment-model guidance were removed ([what's new history, Apr 2026](https://learn.microsoft.com/en-us/graph/whats-new-earlier)). The live page `learn.microsoft.com/graph/teams-licenses` now redirects to the Graph hub (checked 2026-10-03). The previously metered surface (getAllMessages export APIs and tenant or user-wide getAllMessages subscriptions) was application-only or needed a webhook, so it never applied to Commander's delegated per-chat reads.
- **Licensing**: the remaining exceptions are Teams meeting AI insights (Microsoft 365 Copilot licence) and DLP `policyViolation` PATCH ([teams-licenses.md source](https://github.com/microsoftgraph/microsoft-graph-docs-contrib/blob/main/concepts/teams-licenses.md)). Neither matters to Commander. The user just needs Teams.
- **Policy limits on third-party access**:
  1. **Tenant consent policy.** Under the Microsoft-managed default, `Chat.Read`/`Chat.ReadWrite` (plus `Files.Read.All`, `OnlineMeetings.Read`) need admin approval or the admin consent workflow ([manage app consent policies](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies#microsoft-recommended-user-consent-policy)). Apps that require user assignment always need admin consent ([configure user consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent)).
  2. **Admin-consent permissions**: `ChannelMessage.Read.All` and `ChannelMember.Read.All` ([permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)).
  3. **The once-per-day polling rule and the API Terms of Use** ([polling requirements](https://learn.microsoft.com/en-us/graph/api/resources/teams-api-overview?view=graph-rest-1.0#polling-requirements)).
  4. **No "log file" use of send** ([send message in chat](https://learn.microsoft.com/en-us/graph/api/chat-post-messages?view=graph-rest-1.0)).

## Implications for Commander

- **Permissions to request (no admin needed in a tenant like the author's):** `Chat.ReadWrite` (covers reading chats and messages, members, hosted images and mark read/unread), `ChatMessage.Send`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`, plus the existing `User.Read`. Leave out `Chat.Read` if `Chat.ReadWrite` is granted. Ask for these incrementally when the User turns Teams on, not at first sign-in.
- **Optional, admin consent:** `ChannelMessage.Read.All` to read channel posts and replies. Without it, Commander can list teams and channels and send channel replies, but can't read channels. It can still find channel mentions only if search returns them under `Chat.Read`, which is untested. `ChannelMessage.Send` doesn't need admin consent but is only useful once reading works. `Files.Read.All` (to open attachments) and `OnlineMeetings.Read` are user-consentable by flag but blocked under the Microsoft-managed policy. Defer both.
- **Sync method:** poll, keyed on `GET /me/chats?$expand=lastMessagePreview` ordered by last message. Then fetch `/chats/{id}/messages` with `$orderby`+`$filter` on `lastModifiedDateTime` only for chats whose preview time moved, and store a per-chat cursor in SQLite. Respect the 1 rps per chat limit. Delta and webhooks aren't available to a serverless, delegated client.
- **Decision needed (for #34):** a fixed 15-minute background poll conflicts with Microsoft's once-per-day polling rule for Teams. Options:
  - (a) Fetch Teams when the User opens or refreshes Commander, plus a slow background interval. This is the pattern the docs explicitly allow.
  - (b) Accept the risk at 15 minutes, with date-range filters and minimal calls.
  - (c) Add an Azure Event Hubs relay for delegated change notifications. That breaks "no server".
- **What Ares can do:** summarise and sort chat and channel messages into Items using the HTML body, `@mention`s of the User, reactions, attachments as links, and meeting chats. Match People through member `email`/`userId`. Draft and send chat replies and channel thread replies with the User's approval. Mark chats read or unread. Add reactions. **Ares can't** mark channel posts read, thread a reply inside a 1:1 or group chat, or start a new chat with `ChatMessage.Send` alone.
- **What needs admin consent:** reading channel messages (`ChannelMessage.Read.All`) and channel membership (`ChannelMember.Read.All`). In tenants on the Microsoft-managed consent default, `Chat.Read`/`Chat.ReadWrite` too, which matters for testers outside the author's tenant (see #21).

## Sources

Microsoft Learn (Graph):
- Permissions reference: https://learn.microsoft.com/en-us/graph/permissions-reference (raw: https://github.com/microsoftgraph/microsoft-graph-docs-contrib/blob/main/concepts/permissions-reference.md)
- List chats: https://learn.microsoft.com/en-us/graph/api/chat-list?view=graph-rest-1.0
- List messages in a chat: https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0
- List chat members: https://learn.microsoft.com/en-us/graph/api/chat-list-members?view=graph-rest-1.0
- chats-getAllMessages delta (v1.0): https://learn.microsoft.com/en-us/graph/api/chatmessage-delta?view=graph-rest-1.0 ; beta: https://learn.microsoft.com/en-us/graph/api/chatmessage-delta?view=graph-rest-beta
- chats getAllMessages: https://learn.microsoft.com/en-us/graph/api/chats-getallmessages?view=graph-rest-1.0
- channel getAllMessages: https://learn.microsoft.com/en-us/graph/api/channel-getallmessages?view=graph-rest-1.0
- List channel messages: https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0
- Reply to channel message: https://learn.microsoft.com/en-us/graph/api/chatmessage-post-replies?view=graph-rest-1.0
- Send chat message: https://learn.microsoft.com/en-us/graph/api/chat-post-messages?view=graph-rest-1.0
- markChatReadForUser: https://learn.microsoft.com/en-us/graph/api/chat-markchatreadforuser?view=graph-rest-1.0 ; markChatUnreadForUser: https://learn.microsoft.com/en-us/graph/api/chat-markchatunreadforuser?view=graph-rest-1.0
- setReaction: https://learn.microsoft.com/en-us/graph/api/chatmessage-setreaction?view=graph-rest-1.0
- chatMessage resource: https://learn.microsoft.com/en-us/graph/api/resources/chatmessage?view=graph-rest-1.0
- chat resource: https://learn.microsoft.com/en-us/graph/api/resources/chat?view=graph-rest-1.0
- chatMessageAttachment: https://learn.microsoft.com/en-us/graph/api/resources/chatmessageattachment?view=graph-rest-1.0
- chatMessageMention: https://learn.microsoft.com/en-us/graph/api/resources/chatmessagemention?view=graph-rest-1.0
- chatMessageReaction: https://learn.microsoft.com/en-us/graph/api/resources/chatmessagereaction?view=graph-rest-1.0
- aadUserConversationMember: https://learn.microsoft.com/en-us/graph/api/resources/aaduserconversationmember?view=graph-rest-1.0
- Delta query overview: https://learn.microsoft.com/en-us/graph/delta-query-overview
- Teams chatMessage change notifications: https://learn.microsoft.com/en-us/graph/teams-changenotifications-chatmessage
- Webhook delivery: https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks
- Event Hubs delivery: https://learn.microsoft.com/en-us/graph/change-notifications-delivery-event-hubs
- Throttling limits (Teams): https://learn.microsoft.com/en-us/graph/throttling-limits#microsoft-teams-service-limits (raw include: https://github.com/microsoftgraph/microsoft-graph-docs-contrib/blob/main/includes/throttling-teams.md)
- Teams API overview, polling requirements: https://learn.microsoft.com/en-us/graph/api/resources/teams-api-overview?view=graph-rest-1.0#polling-requirements
- Search Teams messages: https://learn.microsoft.com/en-us/graph/search-concept-chat-messages ; search API overview: https://learn.microsoft.com/en-us/graph/api/resources/search-api-overview?view=graph-rest-1.0
- What's new (current): https://learn.microsoft.com/en-us/graph/whats-new-overview ; history: https://learn.microsoft.com/en-us/graph/whats-new-earlier

Microsoft docs source repo (history and pages removed from Learn):
- Teams payment models and licensing (deprecated; live URL redirects): https://github.com/microsoftgraph/microsoft-graph-docs-contrib/blob/main/concepts/teams-licenses.md
- Protected APIs page, last version before deletion: https://github.com/microsoftgraph/microsoft-graph-docs-contrib/blob/ce79b319c5/concepts/teams-protected-apis.md ; deletion: https://github.com/microsoftgraph/microsoft-graph-docs-contrib/commit/05a7c71e17
- Channel-message delta page replaced by chats delta: https://github.com/microsoftgraph/microsoft-graph-docs-contrib/commit/19e966ae13 ; old version: https://github.com/microsoftgraph/microsoft-graph-docs-contrib/blob/7ac3d2f2e3/api-reference/v1.0/api/chatmessage-delta.md

Microsoft Learn (Entra):
- Configure user consent: https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent
- Manage app consent policies (Microsoft-managed policy exclusions): https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies

## Verification

Load-bearing claims re-checked against the source on 2026-10-03:

- **Admin-consent flags** for `Chat.Read`, `Chat.ReadWrite`, `Chat.ReadBasic`, `ChatMessage.Read`, `ChatMessage.Send`, `ChannelMessage.Send`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `OnlineMeetings.Read` (No) and `ChannelMessage.Read.All`, `ChatMember.Read`, `ChannelMember.Read.All` (Yes). Checked twice: on the live permissions reference and in the raw `permissions-reference.md` `AdminConsentRequired` rows. A summarising fetch wrongly reported delegated `Files.Read.All` as admin-consent; the raw table says No (Application Yes, Delegated No), and this note uses the raw value.
- **Delta**: the live v1.0 and beta `chatmessage-delta` pages both show delegated "Not supported" and only `/users/{id}/chats/getAllMessages/delta`. The 2024-09-26 replacement of the channel-delta page was confirmed from the docs repo commit history. The current chatMessage methods table has no channel delta.
- **Read state**: the `markChatReadForUser` permissions table (delegated `Chat.ReadWrite`, application not supported) was read on the live page. The absence of any channel read-state API was checked by searching the full docs repo tree.
- **Change notifications**: the delegated permission rows and the public-HTTPS-endpoint requirement were read on the live pages.
- **Metered / protected**: the no-longer-metered notice (2025-08-25) was read in the current `teams-licenses.md` source and cross-checked against the April 2026 what's-new entry. The live Learn URL redirects to the Graph hub. The protected-API deprecation (2023-05-18) was read in the last pre-deletion version and the deletion commit was confirmed.
- **Throttling and polling**: throttling values are from the raw `throttling-teams.md` include. The polling-requirements text was quoted from both the live page and its source.
- **Consent policy exclusions**: read on the live Entra page (updated 2026-08-28).
- **Not verified by live calls** (no tenant access in this session):
  - whether the old channel-delta URL still responds;
  - whether search returns channel messages under `Chat.Read` alone;
  - which consent policy the author's tenant actually uses;
  - whether the `ChatMessage.Read` scope alone can list chat messages (the API tables name `Chat.Read` as least privileged).
