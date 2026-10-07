// The Core: syncs Sources, holds the Items and runs the Agent. It runs as an Electron
// utilityProcess and talks to the main process only through validated messages.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type CoreAccountRefused, type CoreMessage, createSkillRegistry } from '@commander/domain';
import { createAccessTokens } from './access-tokens';
import { answerRemoveAccountItems } from './account-requests';
import { setUpAgent } from './agent';
import { openGate } from './autonomy/gate';
import { answerAutonomyRequest } from './autonomy/requests';
import { applyPendingRestore, setUpBackups } from './backups';
import { setUpBusyCopies } from './busy-copies';
import { composeFiles, setUpCompose } from './compose';
import { setUpConversations } from './conversations';
import { createAboutReader } from './conversations/about';
import { setUpEmailReader } from './email-reader';
import { workerSanitiser } from './email-reader/sanitiser';
import { setUpGitHubDiscussion } from './github-discussion';
import { setUpGitHubOversight } from './github-oversight';
import { setUpGitHubWatch } from './github-watch';
import { openItemStore } from './item-store';
import { answerItemStoreRequest } from './item-store-requests';
import { setUpMarkdownCopy } from './markdown-copy';
import type { Meaning } from './meaning';
import { meaningInCore } from './meaning/in-core';
import { setUpMeetings } from './meetings';
import { setUpModels } from './models';
import { createKnownSecrets } from './safety/known-secrets';
import { setUpScheduler } from './scheduling';
import { type SendLater, setUpSendLater } from './send-later';
import { createFileSkill } from './skills/file';
import { createFindSkill } from './skills/find';
import { createLinearActionsSkill } from './skills/linear-actions';
import { createManageTodosSkill } from './skills/manage-todos';
import { createSnoozeSkill } from './skills/snooze';
import { createSummariseTarget } from './skills/summarise';
import { setUpSkipInbox } from './skip-inbox';
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

// A restore the User asked for before the relaunch (#202) is made first, while nothing has the
// database open.
const restored = applyPendingRestore({ dataDir });
// Opening it takes a snapshot first when this version of Commander has migrations to run (#202).
const itemStore = openItemStore({
  path: join(dataDir, 'commander.db'),
  snapshotDir: join(dataDir, 'snapshots'),
  // Copied next to the bundled Core at build time (see electron.vite.config.ts).
  migrationsFolder: join(import.meta.dirname, 'migrations'),
});

// Ares's Updates (set up below, once the Agent is): their producers look again whenever the gate acts.
let updates: Updates | undefined;

// Settings → Data's snapshots, Restore and Export everything (#202). The daily snapshot: taken at
// start-up, then checked hourly so a Commander left running still gets one. A failed one is for the
// Update, once Ares's queue is set up below.
const backups = setUpBackups({
  store: itemStore,
  dataDir,
  snapshotDir: join(dataDir, 'snapshots'),
  attachmentsDir: join(dataDir, 'attachments'),
  send: (message) => port.postMessage(message),
  restored,
  queue: () => updates?.queue,
});
backups.takeDaily();
setInterval(() => backups.takeDaily(), 60 * 60 * 1000);

// Sources borrow their Accounts' access tokens from the main process through this, in memory only.
// Each one is remembered by fingerprint, so no prompt to a model can carry it (agent/prompt.ts).
const secrets = createKnownSecrets();
const accessTokens = createAccessTokens((message) => port.postMessage(message), { secrets });
// Model calls for Ares; the API key is borrowed the same way, for each call. Embeddings (search by
// meaning) come from the local model, once it is ready.
let meaning: Meaning | undefined;
const models = setUpModels(itemStore, {
  send: (message) => port.postMessage(message),
  accessTokens,
  secrets,
  meaning: () => meaning,
});
// Search by meaning (#73): the embedding model downloaded on first use into the data folder and run in
// a worker thread beside the Core (built next to it); every Item and memory embedded in the
// background. Nothing leaves the machine. The end-to-end tests use a stand-in, never the real model.
const fakeEmbeddings = process.argv.includes('--embeddings=fake');
meaning = meaningInCore({
  store: itemStore,
  dataDir,
  fake: fakeEmbeddings,
  workerPath: join(import.meta.dirname, 'embed-worker.js'),
  embed: (request) => models.client.embed(request),
});
// A little after start-up, so the first syncs go first.
setTimeout(() => meaning?.start(), fakeEmbeddings ? 0 : 20_000);
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
// Writing email (#138): the files of attachments waiting to be sent, read by the email Sources' writes.
const composeFilesInData = composeFiles(dataDir);
const sync = setUpSync(itemStore, {
  send: (message) => port.postMessage(message),
  accessTokens,
  githubWatch: (account, apiUrl) => githubWatch.forSync(account, apiUrl),
  onAccountsChanged: () => updates?.sweep(),
  attachment: (id) => composeFilesInData.read(id),
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
// Send later's clock (#139), set up below once Ares's queue is: it sends Commander's scheduled mail at
// its time, and finds a time missed while Commander was closed.
let sendLater: SendLater | undefined;
// Writing email (#138): drafts saved and messages sent through the outgoing queue, each send held for
// the Undo time here in the Core (so closing the window keeps it), and sent before Commander quits.
const compose = setUpCompose({
  store: itemStore,
  files: composeFilesInData,
  accounts: () => sync.accounts(),
  canSend: (account) =>
    sync.engine
      .statuses()
      .filter((status) => status.account === account)
      .every((status) => !['offline', 'asleep', 'needs-reconnect'].includes(status.activity)),
  sanitise: emailSanitiser.sanitise,
  reader: emailReader,
  send: (message) => port.postMessage(message),
  onItemsChanged: (itemIds) => port.postMessage({ type: 'items-changed', itemIds } satisfies CoreMessage),
  onScheduleChanged: () => {
    sendLater?.changed();
    updates?.sweep();
  },
});
compose.sweep();
setInterval(() => compose.sweep(), 60 * 60 * 1000);

// The read-only Markdown copy of the Daily Notes, in the folder chosen in Settings → Data.
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
// Snooze's timer, once it is set up below.
let snoozeChanged: (() => void) | undefined;
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
    // Mail Ares sorted into a Bucket that skips the inbox (#142). Read once the gate is set up.
    if (itemIds.length) queueMicrotask(() => skipInboxConsider(itemIds));
    // A thread Ares snoozed (#196), or a snooze undone: the next one may be due sooner.
    if (itemIds.length) snoozeChanged?.();
  },
});

// Skip the inbox (#142): mail a Rule or Ares sorts into a Bucket set to skip the inbox is offered for
// archiving through the gate (Tidy your Sources, Ask by default), as it arrives or is sorted. Mirror
// Buckets is registered there too; the Item store writes the labels for Accounts that mirror.
const skipInbox = setUpSkipInbox({ store: itemStore, gate });
const skipInboxConsider = (itemIds: string[]) => {
  const offered = skipInbox.consider(itemIds);
  if (offered.length) port.postMessage({ type: 'items-changed', itemIds: offered } satisfies CoreMessage);
};
sync.engine.onSynced(({ source, itemIds }) => {
  if (source === 'gmail' || source === 'outlook') skipInboxConsider(itemIds);
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
  // Memory looked up by meaning too (#73), once the embedding model is ready.
  meaning: (text) => meaning?.queryVector(text, 'embed-lookup') ?? Promise.resolve(null),
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

// Ares's Skills (#192), one registry: Find here, the Update, Summarise and Draft with the Updates below.
// Conversations choose from it, and "What Ares can do" lists it.
const skills = createSkillRegistry();
skills.register(
  createFindSkill({
    itemStore,
    meaning: (text) => meaning?.queryVector(text, 'embed-query') ?? Promise.resolve(null),
  }),
);
const summariseTarget = createSummariseTarget({ itemStore });
// Ares's action Skills (#196): what the User tells him to do in a Conversation, each change a proposal
// through the gate, under their Autonomy settings.
skills.register(createManageTodosSkill({ itemStore, gate }));
skills.register(createFileSkill({ itemStore, gate }));
skills.register(createSnoozeSkill({ itemStore, gate }));
skills.register(
  createLinearActionsSkill({
    itemStore,
    gate,
    me: (account) => sync.me(account),
    linearAccounts: () =>
      sync
        .accounts()
        .filter((account) => account.sources.includes('linear'))
        .map((account) => account.account),
  }),
);

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
  // Asking for an Update checks every Teams Account first (a light sync), for up to 2 seconds, unless
  // Teams was checked in the last 2 minutes.
  refreshTeams: () =>
    Promise.all(
      sync
        .accounts()
        .filter((account) => account.sources.includes('teams') && !account.needsReconnect)
        .map((account) => sync.engine.refresh(account.account, 'teams')),
    ),
  send: (message) => port.postMessage(message),
  onState: (state) => port.postMessage({ type: 'ares-updates', ...state } satisfies CoreMessage),
  onIdle: () => {
    agent.idle();
    // Search by meaning's catch-up: anything still missing an embedding.
    meaning?.catchUp();
  },
  // Back at the machine: the daily GitHub summary may be due.
  onReturn: () => agent.active(),
  // Ask Ares to write the GitHub summary (#121).
  summariseGitHub: (request) => agent.githubSummaries.ask(request),
  // Refresh on a People card (#122).
  refreshPersonParagraph: (request) => agent.githubSummaries.refreshPerson(request),
  // Draft a reply (#143) looks Memory up by meaning too.
  meaning: (text) => meaning?.queryVector(text, 'embed-lookup') ?? Promise.resolve(null),
  onItemsChanged: (itemIds) => port.postMessage({ type: 'items-changed', itemIds } satisfies CoreMessage),
  // A missed send-later's Send now and Discard (#139).
  sendLater: { sendNow: (itemId) => compose.sendNow(itemId), discard: (itemId) => compose.discard(itemId) },
  skills,
  summariseTarget,
});
// Injection warnings, and Linear Todos taken off the User's list, arrive with a sync.
sync.engine.onSynced(() => updates?.sweep());
// A snapshot (or restore) that failed before the queue was there.
backups.queueReady();

// Send later (#139): Commander's scheduled mail goes at its time while Commander runs and the machine is
// awake; a time that passed while it was closed (found now) or asleep (found on waking) is missed, and
// Ares asks about it in the next Update. The end-to-end tests may move its clock, or start it moved.
const sendLaterOffsetMs = Number(
  process.argv.find((arg) => arg.startsWith('--send-later-clock-offset-ms='))?.split('=')[1] ?? Number.NaN,
);
sendLater = setUpSendLater({
  store: itemStore,
  testHooks,
  offsetMs: Number.isFinite(sendLaterOffsetMs) ? sendLaterOffsetMs : 0,
  onChanged: (itemIds) => {
    port.postMessage({ type: 'items-changed', itemIds } satisfies CoreMessage);
    updates?.sweep();
  },
});
sync.onSystemState((state) => sendLater?.systemState(state));

// Conversations with Ares (#191): the User's messages answered on the Deep tier, streamed to the window
// as he writes, with his Skills (#192), and about the Item the Ares button was pressed on (#193). A steering flag's mark shows at once in open views. The
// end-to-end tests may treat their fake model (on this machine) as a cloud one, so two Conversations
// answer at once.
const conversations = setUpConversations({
  store: itemStore.conversations,
  client: models.client,
  settings: () => itemStore.models.settings(),
  secrets,
  send: (message) => port.postMessage(message),
  oneAtATime: testHooks && process.argv.includes('--test-model-in-cloud') ? () => false : undefined,
  skills,
  item: (itemId) => itemStore.get(itemId)?.item ?? null,
  // The Item a pop-up Conversation was started from (#193), handed to him with every message.
  readAbout: createAboutReader({ itemStore }),
  injectionWarnings: itemStore.injectionWarnings,
  refusals: itemStore.refusals,
  onItemsChanged: (itemIds) => port.postMessage({ type: 'items-changed', itemIds } satisfies CoreMessage),
});

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
snoozeChanged = () => snooze.changed();

port.on('message', ({ data }) => {
  if (accessTokens.settle(data)) return;
  if (snooze.handle(data)) return;
  if (sendLater?.handle(data)) return;
  if (models.handle(data)) return;
  if (sync.handle(data)) return;
  if (markdownCopy.handle(data)) return;
  if (backups.handle(data)) return;
  if (updates?.handle(data)) return;
  if (conversations.handle(data)) return;
  if (githubWatch.handle(data)) return;
  if (emailReader.handle(data)) return;
  if (compose.handle(data)) return;
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
      // Mail a re-sort put in a Bucket that skips the inbox (#142).
      skipInboxConsider(itemIds);
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
  // A Bucket set to skip the inbox (#142): its mail still in the inbox is offered for archiving.
  const bucketChange = (
    request as { action?: { type?: string; bucketId?: string; bucket?: { skipInbox?: boolean } } }
  )?.action;
  if (
    reply?.type === 'item-store-reply' &&
    reply.response.ok &&
    request?.op === 'change-bucket' &&
    bucketChange?.type === 'update' &&
    bucketChange.bucket?.skipInbox === true &&
    bucketChange.bucketId
  ) {
    const offered = skipInbox.bucketSwitchedOn(bucketChange.bucketId);
    if (offered.length) port.postMessage({ type: 'items-changed', itemIds: offered } satisfies CoreMessage);
  }
  // A GitHub summary opened: its Update line goes. So does a warning's, once Not an instruction
  // clears its mark from where the Item is shown (#201).
  if (
    reply?.type === 'item-store-reply' &&
    reply.response.ok &&
    (request?.op === 'github-summary-seen' || request?.op === 'clear-injection-warning')
  )
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
  conversations.stop();
  meetings.stop();
  snooze.stop();
  sendLater?.stop();
  updates?.stop();
  sync.stop();
  markdownCopy.stop();
  backups.stop();
  emailSanitiser.stop();
  void meaning?.stop();
  itemStore.close();
};
process.on('exit', closeStore);
// Quit stops the Core with SIGTERM (utilityProcess.kill()), which would otherwise end the
// process without running 'exit' handlers.
process.on('SIGTERM', () => {
  closeStore();
  process.exit(0);
});
