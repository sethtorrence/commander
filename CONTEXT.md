# Commander

A personal command center that gathers work from outside services (Linear, email, calendar, GitHub) alongside daily notes and to-dos, so everything going on can be seen and acted on from one place.

## Layout

**Dashboard**:
The main screen, merging items from every Section into one at-a-glance view.
_Avoid_: Home, overview, feed

**Section**:
A notebook-style tab dedicated to one kind of work (Linear, Email, Calendar, GitHub, Notes, Todos), holding that work's full view.
_Avoid_: Tab, module, page, app

## Sources

**Source**:
An outside service Commander syncs with, such as Linear, Gmail, Outlook, or GitHub.
_Avoid_: Integration, provider, connector

**Account**:
One signed-in identity on a Source; a Source may have several Accounts (e.g. 3–4 email Accounts).
_Avoid_: Login, connection, profile

**Two-way sync**:
Changes made in Commander are written back to the Source, and changes in the Source show up in Commander.
_Avoid_: Import, mirror

## Email

**Bucket**:
A category the Agent sorts incoming email into automatically (e.g. needs reply, FYI, newsletters).
_Avoid_: Folder, label, category

**Triage**:
A manual, keyboard-driven pass through email where you decide what happens to each message.
_Avoid_: Inbox zero, processing

## Work and notes

**Todo**:
An item on your to-do lists: a Linear issue (labelled as Linear), a suggestion the Agent drew from your notes, calendar, or email, or one you added yourself.
_Avoid_: Task, action item

**Daily Note**:
The single note for one calendar day, in the Notes Section.
_Avoid_: Journal, entry, page

## Processing

**Agent**:
The background process that continually works through incoming information from every Source, sorting it and pulling out what needs your attention.
_Avoid_: Bot, assistant, worker

**Titanus**:
The name and persona under which the Agent presents itself to the User.
_Avoid_: Assistant, bot, AI

**Update**:
Everything Titanus has queued to tell the User since they last asked, delivered only when the User is active and asks for it.
_Avoid_: Notification, alert, briefing, digest

**Autonomy setting**:
A User's choice, per kind of action and per Section, of how far the Agent may go on its own (act, propose, or stay out).
_Avoid_: Permission, mode, policy

## People

**User**:
A person running their own Commander with their own Accounts; testers are Users too.
_Avoid_: Customer, member, tenant
