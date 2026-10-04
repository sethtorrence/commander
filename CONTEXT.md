# Commander

A personal command center that gathers work from outside services (Linear, email, calendar, GitHub) alongside daily notes and to-dos, so everything going on can be seen and acted on from one place.

## Layout

**Dashboard**:
The main screen, merging items from every Section into one at-a-glance view.
_Avoid_: Home, overview, feed

**Band**:
One of the Dashboard's four groups of what needs the User (Now, Today, Waiting on others, FYI); each Item on the Dashboard sits in one band with a short reason, placed by band rules until Ares ranks it.
_Avoid_: Bucket (that's for email), priority, Rule (that files Items into Projects)

**Section**:
A notebook-style tab dedicated to one kind of work (Notes, Todos, Linear, Email, Calendar, GitHub, Teams, Ares), holding that work's full view.
_Avoid_: Tab, module, page, app

## Sources

**Source**:
An outside service Commander syncs with, such as Linear, Gmail, Outlook, Microsoft Teams, or GitHub.
_Avoid_: Integration, provider, connector

**Account**:
One signed-in identity on a Source; a Source may have several Accounts (e.g. 3–4 email Accounts), and one Account may carry several Sources that share its sign-in (a Google Account carries Gmail and Google Calendar; an Outlook Account carries Outlook and Outlook Calendar).
_Avoid_: Login, connection, profile

**Item**:
Anything Commander tracks, whether it comes from a Source (an email, event, Linear issue, PR) or is made in Commander (a Todo, a Block); every Item has a Project or is Unfiled.
_Avoid_: Record, entity, object, thing

**Link**:
A typed connection between two Items (made from, refers to, finishes, about, caused by), visible from both ends; a refers-to Link may instead point at a Project.
_Avoid_: Relation, reference, edge

**Activity log**:
The one record of every change to an Item or Link: who made it (the User, Ares, a Rule or the Source), why, and what caused it; it powers undo.
_Avoid_: Audit trail, changelog, event log

**Tombstone**:
What Commander keeps of an Item deleted at its Source: hidden from views but kept, so its Links and activity log survive (shown as "deleted in Gmail").
_Avoid_: Soft delete, trash, archive

**Two-way sync**:
Changes made in Commander are written back to the Source, and changes in the Source show up in Commander.
_Avoid_: Import, mirror

**Synced field**:
One part of a Source Item that Two-way sync writes back on its own (a Linear issue's state or priority, each of its labels, each comment); changes, undo and conflicts ("the newer change wins") are all judged per synced field.
_Avoid_: Property, attribute, column

**Invitation**:
A calendar event someone else organised that the User is a guest of, answered with Accept, Maybe or Decline (a synced field); one still waiting for an answer sits in the Dashboard's Today band.
_Avoid_: Invite (as a noun), RSVP (as a noun), meeting request

## Projects

**Project**:
A body of work the User is pursuing (e.g. Longtail, Titanlink, Tactics); every item in Commander belongs to at most one Project, and a Source's own groupings (Linear projects, GitHub repos, email domains) can be mapped into it.
_Avoid_: Workspace, venture, tag, area; and never plain "project" for a Linear or GitHub project, say "Linear project" or "GitHub project"

**Badge**:
A Project's short code on its accent colour (e.g. `LT`), marking which Project an item belongs to; a dashed one is Ares's Suggestion of a Project, waiting for the User to Confirm or Change it.
_Avoid_: Tag, label, icon, chip

**Rule**:
A condition the User sets that files matching items into a Project (or emails into a Bucket); Rules sit in one list the User orders, and the first match wins.
_Avoid_: Filter, automation, mapping (alone)

**Project log**:
The record of every change to a Project itself (made, renamed, recoloured, reordered, archived, merged), kept apart from the Activity log because a Project is not an Item; it powers undo for those changes. The Items a merge moves are in the Activity log too.
_Avoid_: Project history, audit trail

**Unfiled**:
The state of an item that belongs to no Project yet.
_Avoid_: Uncategorised, inbox, misc

## Email

**Bucket**:
What to do with an email (e.g. Needs reply, FYI, Newsletters), defined by the User with a plain description; each email sits in exactly one Bucket, independent of its Project.
_Avoid_: Folder, label, category, tab

**Unsorted**:
The state of an email the Agent hasn't confidently placed in a Bucket yet.
_Avoid_: Uncategorised, unfiled (that's for Projects), inbox

**Triage**:
A manual, keyboard-driven pass through email where you decide what happens to each message.
_Avoid_: Inbox zero, processing

**Snooze**:
Commander's own hold on an email thread until a chosen time: it leaves the inbox for Snoozed and comes back to the top of the inbox at that time, marked unread, while Commander runs (the window or the tray); nothing about it reaches Gmail.
_Avoid_: Remind, defer, Muted (that's for Chats)

**Thread**:
One email conversation in one Account: the messages its reply headers (Message-ID, In-Reply-To, References) tie together, or the Source's own thread for a message without them; the Email Section lists the inbox as threads, while each message stays its own Item.
_Avoid_: Conversation (that's with Ares), chain

## Teams

**Chat**:
A Microsoft Teams one-to-one, group or meeting chat, with its messages.
_Avoid_: Conversation (that's a thread with Ares), thread, DM

**Channel post**:
A message posted in a Microsoft Teams team channel, with its replies.
_Avoid_: Chat, conversation, thread

**Muted Chat**:
A Chat the User keeps and syncs but takes out of unread ordering and counts, the Dashboard and Ares's unprompted summaries; a Commander setting, nothing changes in Teams.
_Avoid_: Snoozed, silenced, archived

**Waiting on you**:
Ares's judgement that someone in a Chat is waiting on the User (a question, a request, a decision), with the message and his one-sentence reason; it puts the Chat on the Dashboard and goes once the User replies, Ares judges it settled, or the User says it isn't (a correction).
_Avoid_: Needs reply (that's a Bucket), mention, unanswered (that's a one-to-one Chat whose latest message isn't the User's)

**Excluded Chat**:
A Chat the User removed from Commander: its Item is deleted (Links show it as gone) and sync skips it until the User includes it again; nothing changes in Teams.
_Avoid_: Hidden (that's Teams' own flag), blocked, left

## Work and notes

**Todo**:
An item on your to-do lists: a Linear issue (labelled as Linear), a review asked of you or an issue assigned to you on GitHub (labelled as GitHub), a suggestion the Agent drew from your notes, calendar, or email, one you added yourself, or a Block you made into one in a Daily Note (`[]`).
_Avoid_: Task, action item

**Daily Note**:
The single note for one calendar day, in the Notes Section; itself an Item, holding its Blocks.
_Avoid_: Journal, entry, page

**Block**:
One line of a Daily Note; Blocks nest under one another, and each belongs to a Project (inherited from its parent unless set) and can become a Todo.
_Avoid_: Line, paragraph, bullet, node

**Meeting chip**:
A Block in today's Daily Note, under its top-level Meetings Block, that stands for one of today's calendar events and shows it as a compact live card; the meeting's notes go under it, and it takes the event's Project.
_Avoid_: Meeting block, event card, meeting note

**Meeting prep**:
Ares's short homework for a meeting, made half an hour before it: what it is about, what was said last time, what is open with the people in it and what is worth raising, each line linked to the Items it rests on; shown folded under the Meeting chip, never as Blocks.
_Avoid_: Briefing, agenda, meeting notes

**Focus block**:
An event holding time to work on one Todo, suggested by Ares in the User's free time and, once accepted, put busy and private in the "Commander" calendar of the Account the User chose, Linked to its Todo (made from).
_Avoid_: Time block, hold, focus time (that's the Calendar Section's panel of suggestions)

**Busy copy**:
The private event titled "Busy" that Block time across Accounts puts on another Account's main calendar for a busy event, carrying nothing else of it, and moving and going with it; Commander never copies one again.
_Avoid_: Mirror, shadow event, blocker

**Daily template**:
The Blocks each new Daily Note starts with, edited in Settings; a new day gets copies of them, not links to them.
_Avoid_: Default note, skeleton, boilerplate

**Markdown copy**:
The read-only `YYYY-MM-DD.md` file of each Daily Note that Commander writes to a folder the User chooses, for Obsidian, grep and backups; never read back, so the database stays the source of truth.
_Avoid_: Export, sync, vault, mirror

## Processing

**Core**:
The background process that keeps Commander running behind the window: it syncs Sources, holds the Items and runs the Agent.
_Avoid_: Backend, server, daemon, engine

**Agent**:
The part of the Core that continually works through incoming information from every Source, sorting it and pulling out what needs your attention.
_Avoid_: Bot, assistant, worker

**Ares**:
The name and persona under which the Agent presents itself to the User.
_Avoid_: Titanus (former name), assistant, bot, AI

**Skill**:
A named ability Ares can use, on request or when he judges it is wanted (e.g. Update, Find, Summarise, Draft, Schedule).
_Avoid_: Tool, command, feature, plugin

**Conversation**:
One thread of typed back-and-forth between the User and Ares; several can run at once.
_Avoid_: Chat, session, thread (alone)

**Memory**:
What Ares has learned and keeps about the User's world (accepted rules, examples from corrections, facts about People and Projects, and the User's preferences), each remembered with where it came from.
_Avoid_: Knowledge base, context, history, profile

**Update**:
Everything Ares has queued to tell the User since they last asked, delivered only when the User is active and asks for it.
_Avoid_: Notification, alert, briefing, digest

**Oversight summary**:
What Shipped, Started, is Stuck and is On fire in the watched GitHub repos over a range of days, grouped by Project then repo and ending "Nothing on fire" when that's true; shown at the top of the GitHub Section. Commander works out its facts from what it holds; Ares writes it from them.
_Avoid_: Report, changelog, commit list

**Skill-managed issue**:
A GitHub issue the User's coding-agent skills keep open on purpose (a wayfinder map or one of its tickets, or a build ticket in a GitHub milestone), recognised by its labels (editable in Settings → GitHub) and shown as progress rather than as old open work; it counts as work only once claimed or closed, and is never Stuck. A **map** is one labelled `wayfinder:map`; its **tickets** are its sub-issues.
_Avoid_: Stale issue, epic, tracking issue; "skill" alone (a Skill is one of Ares's abilities)

**Suggestion**:
Something Ares has prepared and left on its Item for the User to accept or dismiss (what Ask means); nothing happens until it is accepted, and one suggested because of another Item says what caused it.
_Avoid_: Recommendation, proposal (that's what Ares's jobs hand the gate), prompt, nudge

**Warning mark**:
The mark on an outside Item whose text tries to instruct Ares ("This issue contains instructions aimed at Ares. He ignored them."), shown wherever the Item is listed or opened and counted in the Update; it changes nothing Ares may do.
_Avoid_: Alert, flag, quarantine, spam

**Autonomy setting**:
A User's choice, per Action kind and optionally per Section, of the Autonomy level the Agent works at.
_Avoid_: Permission, mode, policy

**Autonomy level**:
How far the Agent may go on its own: Off, Ask (it suggests, the User accepts), Auto when sure, or Auto.
_Avoid_: Trust level, mode

**Action kind**:
A group of Agent actions sorted by who can see the result: Organise (only inside Commander), Tidy your Sources (in the User's own Accounts, unseen by others), Act for you (seen by other people), and Delete (permanent or hard to undo).
_Avoid_: Permission, capability, action type

## People

**User**:
A person running their own Commander with their own Accounts; testers are Users too.
_Avoid_: Customer, member, tenant

**Person**:
Someone the User works with, recognised as the same human across Sources (their GitHub user, Linear user and email addresses).
_Avoid_: Contact, teammate, member, user (that's the person running Commander)

**Handle**:
How a Source names a person on an Item: a Linear user, a GitHub login, a Microsoft (Teams) user or an email address; a Person has many, and each belongs to one Person.
_Avoid_: Identity, alias, account (that's the User's sign-in), username

**People log**:
The record of every change to People (merged, split, renamed, and matched into one by an address they share), kept apart from the Activity log because a Person is not an Item; it powers undo for those changes.
_Avoid_: People history, audit trail
