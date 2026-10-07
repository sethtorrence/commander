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

**Settings**:
Everything the User sets, opened as a temporary tab from the tabs' right edge (or `,`) and arranged in pages chosen from its sidebar (General, Accounts, Ares, Autonomy, Projects, Email, Data, …), each page holding numbered groups; a link elsewhere ("Settings → Accounts") opens it at a page and group.
_Avoid_: Preferences, options; Section (Settings isn't one)

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
What Commander keeps of an Item deleted at its Source: hidden from views but kept, so its Links and activity log survive (shown as "deleted in Gmail"). One whose Account the User removed is bare: none of its content is left, in it or anywhere else in the database ("Removed with its Account").
_Avoid_: Soft delete, trash, archive

**Two-way sync**:
Changes made in Commander are written back to the Source, and changes in the Source show up in Commander.
_Avoid_: Import, mirror

**Synced field**:
One part of a Source Item that Two-way sync writes back on its own (a Linear issue's state or priority, each of its labels, each comment); changes, undo and conflicts ("the newer change wins") are all judged per synced field.
_Avoid_: Property, attribute, column

**Invitation**:
A calendar event someone else organised that the User is a guest of, answered with Accept, Maybe or Decline (a synced field), from Calendar or from the card above the email that carries it; one still waiting for an answer sits in the Dashboard's Today band.
_Avoid_: Invite (as a noun), RSVP (as a noun), meeting request

## Projects

**Project**:
A body of work the User is pursuing (e.g. Longtail, Titanlink, Tactics); every item in Commander belongs to at most one Project, and a Source's own groupings (Linear projects, GitHub repos, email domains) can be mapped into it.
_Avoid_: Workspace, venture, tag, area; and never plain "project" for a Linear or GitHub project, say "Linear project" or "GitHub project"

**Badge**:
A Project's short code on its accent colour (e.g. `LT`), marking which Project an item belongs to; a dashed one is Ares's Suggestion of a Project, waiting for the User to Confirm or Change it.
_Avoid_: Tag, label, icon, chip

**Rule**:
A condition the User sets that files matching items into a Project (or sorts emails into a Bucket); Rules sit in one list the User orders, and the first match (per kind of target) wins.
_Avoid_: Filter, automation, mapping (alone)

**Project log**:
The record of every change to a Project itself (made, renamed, recoloured, reordered, archived, merged), kept apart from the Activity log because a Project is not an Item; it powers undo for those changes. The Items a merge moves are in the Activity log too.
_Avoid_: Project history, audit trail

**Unfiled**:
The state of an item that belongs to no Project yet.
_Avoid_: Uncategorised, inbox, misc

## Email

**Bucket**:
What to do with an email (e.g. Needs reply, FYI, Newsletters), defined by the User with a plain description; each email sits in exactly one Bucket, independent of its Project, and a thread in its latest message's (the User's reply takes the thread's Bucket, so replying never moves it). A dashed one on an Unsorted email is Ares's suggested Bucket, waiting for the User to Confirm or Change it. Buckets stay in Commander unless the User asks: a Bucket set to **skip the inbox** has its mail archived at the Source, and an Account that **mirrors Buckets** shows each email's Bucket there as a Commander label (Gmail) or category (Outlook).
_Avoid_: Folder, label, category, tab

**Unsorted**:
The state of an email the Agent hasn't confidently placed in a Bucket yet.
_Avoid_: Uncategorised, unfiled (that's for Projects), inbox

**Triage**:
A manual, keyboard-driven pass through email, one Bucket at a time, where you decide what happens to each thread with one key (reply, archive, snooze, make it a Todo, move it to another Bucket, set its Project, or skip).
_Avoid_: Inbox zero, processing

**Snooze**:
Commander's own hold on an email thread until a chosen time: it leaves the inbox for Snoozed and comes back to the top of the inbox at that time, marked unread, while Commander runs (the window or the tray); nothing about it reaches Gmail or Outlook.
_Avoid_: Remind, defer, Muted (that's for Chats)

**Thread**:
One email conversation in one Account: the messages its reply headers (Message-ID, In-Reply-To, References) tie together, or the Source's own thread for a message without them; the Email Section lists the inbox as threads, while each message stays its own Item.
_Avoid_: Conversation (that's with Ares), chain

**Draft**:
A message being written, in Commander or in Gmail or Outlook, kept in its Account's Drafts folder so it can be finished in either; never part of a Thread or a view until it is sent.
_Avoid_: Unsent message, compose (as a noun)

**Suggested reply**:
Ares's draft of the User's reply to a Thread, in their own style, waiting at the Thread's end (or, at Ask, offered) until the User opens it in the composer, where it becomes a Draft they edit and send, or dismisses it; nothing of it reaches Gmail or Outlook before then, and Ares never sends it.
_Avoid_: Auto-reply, smart reply, canned response, draft (alone: that's the message in the composer)

**Undo send**:
The few seconds (10 by default, up to 60) every message the User sends waits in the Core before it really goes, with Undo putting it back in the composer.
_Avoid_: Send delay, send later (that's scheduling a send)

**Outbox**:
The messages sent that haven't gone yet: held for Undo send, waiting for a connection, or refused by the Source (with its reason, and Retry).
_Avoid_: Queue, pending mail, sending

**Send later**:
Sending a message at a time the User picks: **held by Microsoft** for an Outlook work Account (Exchange keeps it in its Outbox and sends it with Commander closed), or **sent from Commander** for Gmail (and personal Outlook.com, for now) at that time while Commander runs, the window or the tray. A time Commander missed (closed, or the machine asleep) is never sent late by surprise: Ares asks about it in the next Update.
_Avoid_: Schedule send (as a noun), delay send, Undo send (that's the few seconds every send waits)

**Scheduled**:
The Email Section's view of the messages waiting for their send-later time, each with its time, Account and who holds it, and Edit, Change time, Send now and Cancel; a missed one waits there until the User decides.
_Avoid_: Outbox (that's what was sent and hasn't gone yet), queue, pending

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
An item on your to-do lists: a Linear issue (labelled as Linear), a review asked of you or an issue assigned to you on GitHub (labelled as GitHub), a suggestion the Agent drew from your notes, calendar, email or Teams Chats, one you added yourself, a Block you made into one in a Daily Note (`[]`), or an email you made into one (`t`, "From email").
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

**Booking link**:
The User's own Google appointment-schedule page, saved in Settings → Calendar, that Ares offers instead of a time when scheduling with someone outside the User's organisations (copied, or in a reply to their email for the User to send); Commander only copies it and never hosts booking pages.
_Avoid_: Scheduling link, booking page (that's Google's), Calendly

**Daily template**:
The Blocks each new Daily Note starts with, edited in Settings; a new day gets copies of them, not links to them.
_Avoid_: Default note, skeleton, boilerplate

**Markdown copy**:
The read-only `YYYY-MM-DD.md` file of each Daily Note that Commander writes to a folder the User chooses, for Obsidian, grep and backups; never read back, so the database stays the source of truth.
_Avoid_: Export, sync, vault, mirror

**Snapshot**:
A checked copy of the database in the snapshots folder beside it, with the pasted images it uses: one each day Commander runs (the last 7 kept), one before an update changes the database, and one before each restore; Restore in Settings → Data swaps one in and relaunches Commander, and Export everything copies all the User's data (never a secret) to a folder they choose. When the database fails its check on start, or an update fails (leaving it as it was), the recovery screen offers the snapshot to restore instead of Commander.
_Avoid_: Backup (alone), dump, checkpoint; Export (that's Export everything)

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
A named ability Ares can use, on request or when he judges it is wanted (e.g. Update, Find, Summarise, Draft, Schedule), each listed on What Ares can do; in a Conversation he chooses one from what the User says, and using one is a **Skill step**, at most a few for each message. An **action Skill** (Manage Todos, File, Snooze, Linear actions, Schedule, Change settings) changes nothing itself: each change it is asked for goes to the gate as a proposal, so it runs (reported in his answer, with Undo) or waits as a card in the Conversation, as the User's Autonomy settings say; a change to his own settings always waits for the User, whatever they say. Draft and Meeting prep make something to show under his answer instead (a draft reply the User opens in the composer, a meeting's prep); nothing is sent from a Conversation.
_Avoid_: Tool, command, feature, plugin

**Conversation**:
One thread of typed back-and-forth between the User and Ares; several can run at once. One started with the Ares button is about that Item, which Ares has in front of him with every message.
_Avoid_: Chat, session, thread (alone)

**Ares button**:
The AI mark on an Item's row or detail pane (or `a` on the focused Item) that opens a small pop-up beside it, starting a new Conversation about that Item; **Open in Ares** carries it on in the Ares Section.
_Avoid_: AI button, assistant button, chat bubble

**Memory**:
What Ares has learned and keeps about the User's world (accepted rules, examples from corrections, facts about People and Projects, and the User's preferences), each remembered with where it came from; one he picked up from outside content is unconfirmed, only ever background to him, until the User confirms it. What the User tells him in a Conversation is theirs, so confirmed, with their turn as its source; nothing an Item there says ever is. The User sees and changes it on What Ares knows.
_Avoid_: Knowledge base, context, history, profile

**Update**:
Everything Ares has queued to tell the User since they last asked, delivered only when the User is active and asks for it; each line names what it is about, says what happened, why it matters and what to do, and lists its Items, each with its own actions.
_Avoid_: Notification, alert, briefing, digest

**Oversight summary**:
What Shipped, Started, is Stuck and is On fire in the watched GitHub repos over a range of days, grouped by Project then repo and ending "Nothing on fire" when that's true; shown at the top of the GitHub Section. Commander works out its facts from what it holds; Ares writes it from them each morning (the daily summary), on Mondays (the roll-up) and when asked, and keeps each one.
_Avoid_: Report, changelog, commit list

**Skill-managed issue**:
A GitHub issue the User's coding-agent skills keep open on purpose (a wayfinder map or one of its tickets, or a build ticket in a GitHub milestone), recognised by its labels (editable in Settings → GitHub) and shown as progress rather than as old open work; it counts as work only once claimed or closed, and is never Stuck. A **map** is one labelled `wayfinder:map`; its **tickets** are its sub-issues.
_Avoid_: Stale issue, epic, tracking issue; "skill" alone (a Skill is one of Ares's abilities)

**Suggestion**:
Something Ares has prepared and left on its Item for the User to accept or dismiss (what Ask means), and, when asked for in a Conversation, as a card in his answer there, confirmed with one key; nothing happens until it is accepted, and one suggested because of another Item says what caused it.
_Avoid_: Recommendation, proposal (that's what Ares's jobs hand the gate), prompt, nudge

**Warning mark**:
The mark on an outside Item whose text tries to instruct Ares ("This issue contains instructions aimed at Ares. He ignored them."), shown wherever the Item is listed or opened and named in the Update with what read like an instruction; it changes nothing Ares may do, and the User's Not an instruction (on the mark itself, in the Update or on Flagged Items) clears it, until they undo it.
_Avoid_: Alert, flag, quarantine, spam

**Flagged Items**:
The Ares Section's list of every Item carrying a warning mark, newest first, with what read like an instruction, those the User cleared lately (with Undo), and the Items Ares skipped lately in a Refusal.
_Avoid_: Quarantine, spam folder

**Refusal**:
Ares sending an Item to no model because it holds what looks like one of the User's keys or sign-in tokens: an Activity log entry ("Ares skipped Dana's email…"), a line in the next Update and a small note on the Item, none of them ever showing the secret.
_Avoid_: Block, redaction (that's blanking credential-like text, which still sends the rest)

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

**People view**:
The GitHub Section's view of each Person's week in the watched repos (what they merged and reviewed, what is open and for how long, the reviews waiting on them, their Linear issues), one card each, always by name, with Ares's paragraph about their week; for spotting who is stuck or overloaded, never for ranking. Choosing a Person opens their page.
_Avoid_: Leaderboard, team dashboard, scorecard, stats
