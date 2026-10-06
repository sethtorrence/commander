// The Core: syncs Sources, holds the Items and runs the Agent. It runs as an Electron
// utilityProcess and talks to the main process only through validated messages.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreAccountRefused, CoreMessage } from '@commander/domain';
import { createAccessTokens } from './access-tokens';
import { answerRemoveAccountItems } from './account-requests';
import { setUpAgent } from './agent';
import { openGate } from './autonomy/gate';
import { answerAutonomyRequest } from './autonomy/requests';
import { setUpBusyCopies } from './busy-copies';
import { setUpEmailReader } from './email-reader';
import { workerSanitiser } from './email-reader/sanitiser';
import { setUpGitHubDiscussion } from './github-discussion';
import { setUpGitHubOversight } from './github-oversight';
import { setUpGitHubWatch } from './github-watch';
import { openItemStore } from './item-store';
import { answerItemStoreRequest } from './item-store-requests';
import { setUpMarkdownCopy } from './markdown-copy';
import { setUpMeetings } from './meetings';
import { setUpModels } from './models';
import { createKnownSecrets } from './safety/known-secrets';
import { setUpScheduler } from './scheduling';
import { setUpSnooze } from './snooze';
import { setUpSync } from './sync';
import { setUpUpdates, type Updates } from './updates';

const port = process.parentPort;
let beats = 0;

setInterval(() => {
  beats += 1;
  const message: CoreMessage = { type: 'heartbeat', beats, at: Date.now() };
  port.postMessage(message);
}, 1000);

// The main process passes the app's data folder; the Core never touches Electron main-process APIs.
const dataDir = process.argv.find((arg) => arg.startsWith('--data-dir='))?.slice('--data-dir='.length);
if (!dataDir) throw new Error('The Core needs --data-dir=<folder> to know where the database lives');
mkdirSync(dataDir, { recursive: true });

const itemStore = openItemStore({
  path: join(dataDir, 'commander.db'),
  snapshotDir: join(dataDir, 'snapshots'),
  // Copied next to the bundled Core at build time (see electron.vite.config.ts).
  migrationsFolder: join(import.meta.dirname, 'migrations'),
});

// The daily snapshot: taken at start-up, then checked hourly so a Commander left running still gets one.
itemStore.takeDailySnapshot();
setInterval(() => itemStore.takeDailySnapshot(), 60 * 60 * 1000);

// Sources borrow their Accounts' access tokens from the main process through this, in memory only.
// Each one is remembered by fingerprint, so no prompt to a model can carry it (agent/prompt.ts).
const secrets = createKnownSecrets();
const accessTokens = createAccessTokens((message) => port.postMessage(message), { secrets });
// Model calls for Ares; the API key is borrowed the same way, for each call.
const models = setUpModels(itemStore, {
  send: (message) => port.postMessage(message),
  accessTokens,
  secrets,
});
// Ares's Updates (set up below, once the Agent is): their producers look again whenever the gate acts.
let updates: Updates | undefined;
// Settings → GitHub: what each GitHub Account can reach and watches, kept through the Item store.
const githubWatch = setUpGitHubWatch(itemStore, {
  send: (message) => port.postMessage(message),
  accessTokens,
  // The end-to-end tests may save GitHub Items as sync will.
  testHooks: process.argv.includes('--test-hooks'),
});
// The GitHub Section: a pull request's or issue's discussion, fetched when it is opened.
const githubDiscussion = setUpGitHubDiscussion(itemStore, {
  send: (message) => port.postMessage(message),
  accessTokens,
});
// Source sync: every Account on its cadence, writing through the Item store. GitHub sync reads what
// each Account watches. An Account needing reconnecting (or reconnected) is Ares's to mention in the
// next Update.
const sync = setUpSync(itemStore, {
  send: (message) => port.postMessage(message),
  accessTokens,
  githubWatch: (account, apiUrl) => githubWatch.forSync(account, apiUrl),
  onAccountsChanged: () => updates?.sweep(),
});
// The oversight summary (#119): finishes Links after GitHub and Linear syncs, and the writer's detail
// fetched for the pull requests in today's summary. What it links shows at once in open views.
const githubOversight = setUpGitHubOversight(itemStore, {
  accessTokens,
  apiUrl: () => sync.githubApiUrl(),
  onSignInRefused: (account) =>
    port.postMessage({ type: 'account-refused', account } satisfies CoreAccountRefused),
});
sync.engine.onSynced((event) => {
  void githubOversight.synced(event).then((itemIds) => {
    if (itemIds.length) port.postMessage({ type: 'items-changed', itemIds } satisfies CoreMessage);
    // Once the pull requests' detail is in, the daily GitHub summary may be due (#121).
    if (event.source === 'github' && event.outcome === 'synced') void agent.githubSummaries.due();
  });
});
// The email reader (#134): each message's HTML sanitised for the sandboxed frame, its parts fetched
// through its Source and cached in the Account's folder, and the image rules. The end-to-end tests may
// save email Items as an email Source's sync will (Outlook's, until its mail sync lands).
// Sanitising runs in a worker thread beside the Core (built next to it), each message within 10 s.
const emailSanitiser = workerSanitiser(join(import.meta.dirname, 'email-sanitiser.js'));
const emailReader = setUpEmailReader({
  store: itemStore,
  sanitise: emailSanitiser.sanitise,
  dataDir,
  accessTokens,
  adapterFor: (source) => sync.adapterFor(source),
  accounts: () => sync.accounts(),
  send: (message) => port.postMessage(message),
  testHooks: process.argv.includes('--test-hooks'),
  onItemsChanged: (itemIds) => port.postMessage({ type: 'items-changed', itemIds } satisfies CoreMessage),
});
// The read-only Markdown copy of the Daily Notes, in the folder chosen in Settings → Notes.
const markdownCopy = setUpMarkdownCopy({
  store: itemStore,
  dataDir,
  attachmentsDir: join(dataDir, 'attachments'),
  send: (message) => port.postMessage(message),
});
markdownCopy.start();
// What a sync changed (new Linear Todos among it) shows at once in open views.
sync.engine.onSynced(({ itemIds }) => {
  if (itemIds.length) port.postMessage({ type: 'items-changed', itemIds } satisfies CoreMessage);
  // A Linear-backed Todo ticked in Linear ticks its Block's checkbox in the copy.
  markdownCopy.itemsChanged(itemIds);
});

// The gate every Ares action goes through. Test hooks (proposing from end-to-end tests) are on only
// when the main process asks for them.
const testHooks = process.argv.includes('--test-hooks');
const gate = openGate({
  itemStore,
  onChange: (itemIds, suggestionsOn) => {
    port.postMessage({ type: 'ares-activity', at: Date.now() } satisfies CoreMessage);
    // What Ares added (or the User accepted, or undid) shows in every open Section, and so does a
    // suggestion shown or gone (the dashed Badge).
    const seen = [...new Set([...itemIds, ...suggestionsOn])];
    if (seen.length) port.postMessage({ type: 'items-changed', itemIds: seen } satisfies CoreMessage);
    // And in the Markdown copy: an Ares Todo puts a checkbox on its Block there too.
    markdownCopy.itemsChanged(itemIds);
    // A suggested (or added) Todo is ranked on the Dashboard.
    agent.aresChanged();
    updates?.sweep();
  },
});

// Ares's jobs, on their triggers. The end-to-end tests may shorten the pause after typing.
const typingPauseMs = Number(
  process.argv.find((arg) => arg.startsWith('--ares-typing-pause-ms='))?.split('=')[1] ?? Number.NaN,
);
// The end-to-end tests may have the daily GitHub summary due from another hour than 05:00.
const summaryHour = Number(
  process.argv.find((arg) => arg.startsWith('--github-summary-hour='))?.split('=')[1] ?? Number.NaN,
);
// They may also leave out the Monday roll-up, so a test sees the same summary on any day.
const summaryRollUp = !process.argv.includes('--github-summary-rollup=off');
const agent = setUpAgent(itemStore, {
  gate,
  client: models.client,
  send: (message) => port.postMessage(message),
  typingPauseMs: testHooks && Number.isFinite(typingPauseMs) ? typingPauseMs : undefined,
  secrets,
  // A steering warning mark shows at once in open views.
  onItemsChanged: (itemIds) => port.postMessage({ type: 'items-changed', itemIds } satisfies CoreMessage),
  // Stuck Linear issues go in Ares's queue, for the next Update.
  enqueue: (input) => updates?.queue.enqueue(input),
  // Who the User is in each Account: their Linear user, their Teams user.
  me: (account) => sync.me(account),
  // The GitHub summary (#121): the pull requests' detail fetched first, and each one written is for
  // the Update to mention.
  prepareWriterDetails: (itemIds) => githubOversight.prepareWriterDetails(itemIds),
  summaryHour: testHooks && Number.isFinite(summaryHour) ? summaryHour : undefined,
  summaryRollUp: testHooks ? summaryRollUp : true,
  onSummaryWritten: () => {
    updates?.sweep();
    // The Dashboard reads its row again.
    port.postMessage({ type: 'ares-activity', at: Date.now() } satisfies CoreMessage);
  },
});
sync.engine.onSynced((event) => agent.synced(event));

// Ares's queue and the Update Skill. The main process reports the User's presence (powerMonitor);
// the queued count and "You're here / away" go to the window as they change, and the machine going
// idle is the Agent's cue for its catch-up work. Nothing here ever draws the User's attention.
updates = setUpUpdates({
  itemStore,
  gate,
  client: models.client,
  secrets,
  accounts: () => sync.accounts(),
  me: (account) => sync.me(account),
  // Asking for an Update checks every Teams Account first (a light sync), for up to 5 seconds.
  refreshTeams: () =>
    Promise.all(
      sync
        .accounts()
        .filter((account) => account.sources.includes('teams') && !account.needsReconnect)
        .map((account) => sync.engine.refresh(account.account, 'teams')),
    ),
  send: (message) => port.postMessage(message),
  onState: (state) => port.postMessage({ type: 'ares-updates', ...state } satisfies CoreMessage),
  onIdle: () => agent.idle(),
  // Back at the machine: the daily GitHub summary may be due.
  onReturn: () => agent.active(),
  // Ask Ares to write the GitHub summary (#121).
  summariseGitHub: (request) => agent.githubSummaries.ask(request),
  onItemsChanged: (itemIds) => port.postMessage({ type: 'items-changed', itemIds } satisfies CoreMessage),
});
// Injection warnings, and Linear Todos taken off the User's list, arrive with a sync.
sync.engine.onSynced(() => updates?.sweep());

// Today's meetings (#128): the meeting chips in today's Daily Note follow each calendar sync, and the
// opt-in heads-up comes 2 minutes before a meeting (shown by the main process) while someone is there.
const meetings = setUpMeetings({
  store: itemStore,
  send: (message) => {
    port.postMessage(message);
    // The Markdown copy writes the chips too.
    if (message.type === 'items-changed') markdownCopy.itemsChanged(message.itemIds);
  },
  presence: () => updates?.presence.current().state ?? 'active',
});
meetings.refresh();
sync.engine.onSynced((event) => {
  if (event.source === 'google-calendar' || event.source === 'outlook-calendar') meetings.refresh();
});

// Ares's scheduler (#132): Find time answers once guests' free/busy is in (or not to be had), asking the
// providers through the User's own Accounts.
const scheduler = setUpScheduler({
  store: itemStore,
  accounts: () => sync.accounts(),
  freeBusy: (account, source, request) => sync.freeBusy(account, source, request),
});

// Block time across Accounts (#131): Busy copies follow each calendar sync, and the pairs in
// Settings → Calendar (a pair switched on sets its action to Auto). Copies are made through the gate.
const busyCopies = setUpBusyCopies({ store: itemStore, gate });
const copiesChanged = (itemIds: string[]) => {
  if (itemIds.length) port.postMessage({ type: 'items-changed', itemIds } satisfies CoreMessage);
};
copiesChanged(busyCopies.reconcile());
sync.engine.onSynced((event) => {
  if (event.source === 'google-calendar' || event.source === 'outlook-calendar') {
    copiesChanged(busyCopies.reconcile());
  }
});
// Snoozed mail (#135) comes back at its time while Commander runs, and at start-up if its time passed
// while Commander was closed. The end-to-end tests may move its clock on.
const snooze = setUpSnooze({ store: itemStore, send: (message) => port.postMessage(message), testHooks });

port.on('message', ({ data }) => {
  if (accessTokens.settle(data)) return;
  if (snooze.handle(data)) return;
  if (models.handle(data)) return;
  if (sync.handle(data)) return;
  if (markdownCopy.handle(data)) return;
  if (updates?.handle(data)) return;
  if (githubWatch.handle(data)) return;
  if (emailReader.handle(data)) return;
  if (githubDiscussion.handle(data)) return;
  if (scheduler.handle(data, (reply) => port.postMessage(reply))) return;
  let changed: CoreMessage | null = null;
  let changedIds: string[] = [];
  // Settings → Calendar's focus time as it was, to tell which pairs the User switched on.
  const focusBefore =
    (data as { request?: { op?: string } }).request?.op === 'save-focus-settings'
      ? itemStore.focusSettings.read()
      : null;
  const reply =
    answerRemoveAccountItems(itemStore, data, (account) => {
      sync.forget(account);
      // Its cached attachments and inline images, and its image rules, go too.
      emailReader.forget(account);
    }) ??
    answerItemStoreRequest(itemStore, data, (itemIds) => {
      changed = { type: 'items-changed', itemIds };
      changedIds = itemIds;
      // The window's changes are the User's: typing in a Daily Note, say.
      agent.userChanged(itemIds);
    }) ??
    answerAutonomyRequest(gate, data, { testHooks, jobs: agent.runner, filing: agent.filing });
  if (reply) port.postMessage(reply);
  // A calendar switched on is synced at once (one switched off is hidden by the change itself).
  const request = (data as { request?: { op?: string; account?: string; calendarId?: string; on?: boolean } })
    .request;
  if (reply?.type === 'item-store-reply' && reply.response.ok && request?.op === 'set-calendar-enabled') {
    const calendar =
      request.on && request.account && request.calendarId
        ? itemStore.calendars.get(request.account, request.calendarId)
        : null;
    if (calendar) void sync.engine.refresh(calendar.account, calendar.source);
  }
  // After the reply, so the window that made the change has its answer first.
  if (changed) port.postMessage(changed);
  if (focusBefore && reply?.type === 'item-store-reply' && reply.response.ok) {
    copiesChanged(busyCopies.settingsSaved(focusBefore, itemStore.focusSettings.read()));
  }
  // A snooze set or undone: the next one may be due sooner.
  if (changedIds.length) snooze.changed();
  // A GitHub summary opened: its Update line goes.
  if (reply?.type === 'item-store-reply' && reply.response.ok && request?.op === 'github-summary-seen')
    updates?.sweep();
  // Today's Daily Note made (Notes opening, or the date passing midnight): its meeting chips go in.
  if (reply?.type === 'item-store-reply' && reply.response.ok && request?.op === 'daily-note')
    meetings.refresh();
  // The Markdown copy writes the days the change touched, a moment later.
  if (reply?.type === 'item-store-reply') {
    markdownCopy.itemsChanged(changedIds);
    markdownCopy.afterRequest((data as { request?: unknown }).request);
  }
});

// Closing the last connection checkpoints the WAL into commander.db.
let closed = false;
const closeStore = () => {
  if (closed) return;
  closed = true;
  agent.stop();
  meetings.stop();
  snooze.stop();
  updates?.stop();
  sync.stop();
  markdownCopy.stop();
  emailSanitiser.stop();
  itemStore.close();
};
process.on('exit', closeStore);
// Quit stops the Core with SIGTERM (utilityProcess.kill()), which would otherwise end the
// process without running 'exit' handlers.
process.on('SIGTERM', () => {
  closeStore();
  process.exit(0);
});
