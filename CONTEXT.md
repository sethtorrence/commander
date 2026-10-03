# Commander

A personal command center that gathers work from outside services (Linear, email, calendar, GitHub) alongside daily notes and to-dos, so everything going on can be seen and acted on from one place.

## Layout

**Dashboard**:
The main screen, merging items from every Section into one at-a-glance view.
_Avoid_: Home, overview, feed

**Section**:
A notebook-style tab dedicated to one kind of work (Notes, Todos, Linear, Email, Calendar, GitHub, Teams, Ares), holding that work's full view.
_Avoid_: Tab, module, page, app

## Sources

**Source**:
An outside service Commander syncs with, such as Linear, Gmail, Outlook, Microsoft Teams, or GitHub.
_Avoid_: Integration, provider, connector

**Account**:
One signed-in identity on a Source; a Source may have several Accounts (e.g. 3–4 email Accounts).
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

## Projects

**Project**:
A body of work the User is pursuing (e.g. Longtail, Titanlink, Tactics); every item in Commander belongs to at most one Project, and a Source's own groupings (Linear projects, GitHub repos, email domains) can be mapped into it.
_Avoid_: Workspace, venture, tag, area; and never plain "project" for a Linear or GitHub project, say "Linear project" or "GitHub project"

**Badge**:
A Project's short code on its accent colour (e.g. `LT`), marking which Project an item belongs to.
_Avoid_: Tag, label, icon, chip

**Rule**:
A condition the User sets that files matching items into a Project (or emails into a Bucket); Rules sit in one list the User orders, and the first match wins.
_Avoid_: Filter, automation, mapping (alone)

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

## Teams

**Chat**:
A Microsoft Teams one-to-one, group or meeting chat, with its messages.
_Avoid_: Conversation (that's a thread with Ares), thread, DM

**Channel post**:
A message posted in a Microsoft Teams team channel, with its replies.
_Avoid_: Chat, conversation, thread

## Work and notes

**Todo**:
An item on your to-do lists: a Linear issue (labelled as Linear), a suggestion the Agent drew from your notes, calendar, or email, or one you added yourself.
_Avoid_: Task, action item

**Daily Note**:
The single note for one calendar day, in the Notes Section; itself an Item, holding its Blocks.
_Avoid_: Journal, entry, page

**Block**:
One line of a Daily Note; Blocks nest under one another, and each belongs to a Project (inherited from its parent unless set) and can become a Todo.
_Avoid_: Line, paragraph, bullet, node

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

**Suggestion**:
Something Ares has prepared and left on its Item for the User to accept or dismiss (what Ask means); nothing happens until it is accepted, and one suggested because of another Item says what caused it.
_Avoid_: Recommendation, proposal (that's what Ares's jobs hand the gate), prompt, nudge

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
