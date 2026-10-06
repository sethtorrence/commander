// Ares's Updates in the Core (#23, #70). Ares never interrupts: what he wants to tell the User waits
// in his queue (queue.ts), and the User gets it only by asking, through the Update Skill.
//
// - Producers (producers.ts) look for what's new whenever the gate does something, after a sync and
//   every minute: suggestions Ares wasn't sure about, chained suggestions, injection warnings, the
//   80% cost-cap warning, "want me to just do these?" Autonomy changes, and from Linear (linear.ts)
//   issues taken off the User's list, stuck issues that changed, and Accounts needing reconnecting,
//   and from Teams (teams.ts) busy Chats, which Ares summarises when the Update is put together.
// - Presence (presence.ts) follows what the main process reports of powerMonitor: it drives only
//   "You're here / away" and having the Update ready on return (put together in the background
//   when the User comes back), and tells the Agent the machine is idle for its catch-up work.
// - The Update Skill gives an Update: the queued lines in order, each saying what it is, what
//   happened, why it matters and what to do, in Ares's words (compose.ts) or the plain sentence of
//   its kind (kinds/), with the smaller things folded after more than 8 hours away (never after a
//   busy day). Every Update given is kept, so the last one, or any earlier one, can be reopened, and
//   each line lists its Items (kinds/), each with its own actions. Asking for one first runs a light
//   sync of every Teams Account, waiting up to 2 seconds before going on with what's there.
// - The Summarise Skill (#109) summarises a Chat on request, over a range of its messages, and the
//   Draft Skill (#110) drafts a reply to one, for the User to edit and send (never while "Draft
//   replies" is Off).
// - Acting on a line: Done and Dismiss take it out of the queue (Dismiss also dismisses the
//   suggestions it is about), Snooze hides it until later, and Accept takes a suggestion in place,
//   through the gate, or raises an action's Autonomy level one step (never past its hard limit).
// - Acting on one of its Items (#186): Accept or Dismiss its suggestion, Tick its Linear Todo, Not
//   an instruction (clears its warning mark), or Dismiss it from the line; the line goes once none
//   of its Items is left.
import {
  type AutonomyLevel,
  autonomyLevels,
  type ChatDraft,
  type ChatSummary,
  chosenLevel,
  createSkillRegistry,
  DRAFT_REPLIES,
  DRAFT_SKILL,
  type DraftEmailRequest,
  decide,
  type GitHubSummaryAnswer,
  type GivenUpdate,
  HARD_LIMITS,
  isAllowed,
  type PersonParagraphAnswer,
  type PersonParagraphRequest,
  type PresenceReport,
  presenceReport,
  type QueuedAction,
  type QueuedLine,
  type ReadyReply,
  type RowAction,
  type SkillRegistry,
  type SnoozeChoice,
  SUMMARISE_SKILL,
  type SummaryRange,
  type SummaryRequest,
  UPDATE_SKILL,
  UPDATES_MESSAGES,
  type UpdateLine,
  type UpdateSummary,
  type UpdatesState,
  type UpdateView,
  updatesRequest,
} from '@commander/domain';
import type { ModelClient } from '@commander/models';
import { z } from 'zod';
import { draftEmailReply } from '../agent/draft-email-reply';
import { draftReply } from '../agent/draft-reply';
import type { MeaningLookup } from '../agent/memory-context';
import { summariseChat } from '../agent/summarise-chat';
import type { Gate } from '../autonomy/gate';
import type { ItemStore } from '../item-store';
import type { KnownSecrets } from '../safety/known-secrets';
import { compose } from './compose';
import { type LineContext, lineRows, lineTemplate, lineWithout } from './kinds';
import type { WatchedAccount } from './linear';
import { AWAY_AFTER_MS, createPresence, type PresenceModel } from './presence';
import { createProducers } from './producers';
import { createUpdateQueue, type UpdateQueue } from './queue';
import { summaries } from './teams';

export type { WatchedAccount } from './linear';
export type { UpdateQueue } from './queue';

// After more than 8 hours away, the five most important things lead and the rest fold.
const LEAD = 5;
const SWEEP_EVERY_MS = 60_000;
// How long asking for an Update waits on the light Teams sync before going on with what's there
// (the sync carries on, and what it finds is for the next Update).
const REFRESH_WAIT_MS = 2_000;
// Teams checked this recently is fresh enough: asking again (reopening the Update) doesn't wait.
const REFRESH_FRESH_MS = 2 * 60_000;

export type UpdatesOptions = {
  itemStore: ItemStore;
  gate: Pick<Gate, 'accept' | 'acceptAll' | 'dismiss' | 'actions' | 'settings' | 'setLevel'>;
  client: ModelClient;
  secrets?: KnownSecrets;
  now?: () => number;
  // Every Account and whether it needs reconnecting (from Source sync), for Reconnect lines.
  accounts?: () => readonly WatchedAccount[];
  // Who the User is in a Teams Account (their Microsoft user id), from Source sync, when known.
  me?: (account: string) => string | null;
  // A light sync of every Teams Account, run when the User asks for an Update (#109).
  refreshTeams?: () => Promise<unknown>;
  // How long asking waits on it before going on (2 seconds; tests shorten it).
  refreshWaitMs?: number;
  // The quiet count or the User's presence changed.
  onState?: (state: UpdatesState) => void;
  // The User stopped being active: the Agent's catch-up work can run.
  onIdle?: () => void;
  // The User came back to the machine: the daily GitHub summary may be due (#121).
  onReturn?: () => void;
  // Ask Ares to write the GitHub summary for a range and scope (#121).
  summariseGitHub?: (request: SummaryRequest) => Promise<GitHubSummaryAnswer>;
  // Refresh on a People card: Ares writes one Person's paragraph again (#122).
  refreshPersonParagraph?: (request: PersonParagraphRequest) => Promise<PersonParagraphAnswer>;
  // Search by meaning (#73): what a draft of an email reply looks Memory up by, embedded.
  meaning?: MeaningLookup;
  // Items the Update's steering flag marked.
  onItemsChanged?: (itemIds: string[]) => void;
  // Replies to the window's requests (through the main process).
  send?: (message: unknown) => void;
  log?: (message: string) => void;
};

export type Updates = {
  // Where any part of Commander enqueues something for the next Update.
  queue: UpdateQueue;
  presence: PresenceModel;
  // Ares's Skills; the Update is the first.
  skills: SkillRegistry;
  // The producers look for anything new to queue, and settled lines leave.
  sweep(): void;
  state(): UpdatesState;
  // The Update Skill: gives (and keeps) an Update, or null when nothing is queued.
  give(): Promise<UpdateView | null>;
  // The Summarise Skill: Ares summarises a Chat over a range of its messages.
  summarise(itemId: string, range: SummaryRange): Promise<ChatSummary>;
  // The Draft Skill: Ares drafts a reply to a Chat, for the User to edit and send.
  draft(itemId: string): Promise<ChatDraft>;
  // Draft a reply (#143): Ares drafts the User's reply to an email thread, kept as its suggested reply.
  draftEmail(request: DraftEmailRequest): Promise<ReadyReply>;
  history(limit?: number): UpdateSummary[];
  past(id: number): UpdateView;
  act(queuedId: number, action: QueuedAction, snooze?: SnoozeChoice): QueuedLine;
  // One of a line's Items, acted on in the Update.
  actRow(queuedId: number, itemId: string, action: RowAction): QueuedLine;
  // A message from the main process (the window's requests, presence reports). True when it was ours.
  handle(message: unknown): boolean;
  stop(): void;
};

const envelope = z.object({ type: z.literal(UPDATES_MESSAGES.request), id: z.number().int().positive() });

// One step up from a level, if the kind's hard limit allows it.
function stepUp(level: AutonomyLevel, kind: keyof typeof HARD_LIMITS): AutonomyLevel | null {
  const next = autonomyLevels[autonomyLevels.indexOf(level) + 1];
  return next && level !== 'off' && isAllowed(kind, next) ? next : null;
}

export function setUpUpdates(options: UpdatesOptions): Updates {
  const { itemStore, gate } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  const store = itemStore.updates;

  let lastState = '';
  function reportState() {
    const current = state();
    const key = JSON.stringify(current);
    if (key === lastState) return;
    lastState = key;
    options.onState?.(current);
  }

  const queue = createUpdateQueue({ store, now, onChange: () => reportState() });
  const producers = createProducers({
    itemStore,
    gate,
    queue,
    now,
    accounts: options.accounts,
    me: options.me,
  });
  const presence = createPresence({
    store,
    now,
    onChange: () => reportState(),
    // Back at the machine: the Update is put together now, so it is ready when asked for.
    onReturn: () => {
      options.onReturn?.();
      void prepare();
    },
    onLeave: () => options.onIdle?.(),
  });

  function state(): UpdatesState {
    return { queued: queue.count(), presence: presence.current() };
  }

  function sweep() {
    try {
      producers.sweep();
    } catch (error) {
      log(`Ares's queue couldn’t look for new things: ${error instanceof Error ? error.message : error}`);
    }
    reportState();
  }

  const item = (itemId: string) => itemStore.get(itemId)?.item ?? null;

  // What the kinds of line read about their Items (kinds/), as things stand now.
  function lineContext(): LineContext {
    let todos: Map<string, string> | null = null;
    return {
      item,
      proposal: (id) => itemStore.autonomy.proposal(id),
      proposalsOn: (itemId) => itemStore.autonomy.proposals({ itemId, limit: 20 }),
      projectCode: (projectId) =>
        itemStore.projects({ includeArchived: true }).find((project) => project.id === projectId)?.code ??
        null,
      bucketName: (bucketId) => itemStore.buckets().find((bucket) => bucket.id === bucketId)?.name ?? null,
      warning: (itemId) => itemStore.injectionWarnings.warning(itemId),
      todoOf(issueId) {
        todos ??= new Map(
          itemStore
            .query({ kinds: ['todo'], statuses: ['open'], limit: 1000 })
            .flatMap((todo) =>
              todo.detail?.kind === 'todo' && todo.detail.backedBy ? [[todo.detail.backedBy, todo.id]] : [],
            ),
        );
        return todos.get(issueId) ?? null;
      },
      me: (account) => options.me?.(account) ?? null,
      now: now(),
    };
  }

  // What Ares would say about these lines. The last one put together is reused while the queue
  // hasn't changed since (put together on the User's return, say).
  let prepared: { key: string; texts: Promise<Awaited<ReturnType<typeof compose>>> } | null = null;
  const keyOf = (lines: readonly QueuedLine[]) =>
    lines.map((line) => `${line.id}:${line.updatedAt}:${line.itemIds.length}`).join(',');

  function texts(lines: readonly QueuedLine[]) {
    const key = keyOf(lines);
    if (prepared?.key !== key) {
      prepared = {
        key,
        // Busy Chats are summarised now, as the Update is put together, alongside the rest's words.
        texts: Promise.all([
          summaries(lines, {
            itemStore,
            client: options.client,
            now,
            me: options.me,
            secrets: options.secrets,
            onItemsChanged: options.onItemsChanged,
            log,
          }),
          compose(lines, {
            client: options.client,
            context: lineContext(),
            secrets: options.secrets,
            injectionWarnings: itemStore.injectionWarnings,
            onItemsChanged: options.onItemsChanged,
            log,
          }),
        ]).then(([written, composed]) => ({
          texts: new Map([...composed.texts, ...written]),
          voice: written.size ? ('ares' as const) : composed.voice,
        })),
      };
    }
    return prepared.texts;
  }

  // The lines an Update gives now: in order, and the ones the model words (only the lead, when folded).
  function plan() {
    sweep();
    const lines = queue.list();
    const awayMs = presence.awayMs();
    const folded = awayMs > AWAY_AFTER_MS && lines.length > LEAD;
    return { lines, awayMs, folded, worded: folded ? lines.slice(0, LEAD) : lines };
  }

  async function prepare() {
    const { worded } = plan();
    if (worded.length) await texts(worded);
  }

  // What a line's text may link to (AresText): its Items' titles, and a busy Chat's messages.
  function sourcesOf(line: QueuedLine): string[] {
    const titles = line.itemIds.map((itemId) => item(itemId)?.title ?? '');
    if (line.about.kind !== 'chat-summary') return titles;
    const chat = item(line.about.itemId);
    const since = line.about.since;
    const said =
      chat?.detail?.kind === 'chat'
        ? chat.detail.messages.filter((message) => message.createdAt > since).map((message) => message.text)
        : [];
    return [...titles, ...said];
  }

  // An Update as the panel shows it: each line as its queued line stands now, with its Items.
  function view(update: GivenUpdate): UpdateView {
    const context = lineContext();
    return {
      ...update,
      lines: update.lines.map((line) => {
        const queued = store.line(line.queuedId);
        const rows = queued
          ? lineRows(queued, line.itemIds, context, { waiting: queued.status === 'queued' })
          : [];
        return { ...line, queued, rows };
      }),
    };
  }

  async function give(): Promise<UpdateView | null> {
    const { lines, awayMs, folded, worded } = plan();
    if (!lines.length) return null;
    const lastGivenAt = store.state().lastGivenAt;
    // Asked again with nothing new: the same Update, not another copy of it in the history.
    const last = store.history(1)[0];
    if (
      last &&
      lines.every((line) => line.updatedAt <= last.at && last.lines.some((was) => was.queuedId === line.id))
    ) {
      return view(last);
    }
    const composed = await texts(worded);
    const context = lineContext();
    const lead = new Set(worded.map((line) => line.id));
    const given: UpdateLine[] = lines.map((line) => ({
      queuedId: line.id,
      group: line.group,
      kind: line.about.kind,
      text: composed.texts.get(line.id) ?? lineTemplate(line, context),
      itemIds: line.itemIds,
      section: line.section,
      sources: sourcesOf(line),
      folded: folded && !lead.has(line.id),
      fresh: lastGivenAt === null || line.updatedAt > lastGivenAt,
    }));
    const saved = store.saveUpdate({ at: now(), awayMs, folded, voice: composed.voice, lines: given });
    presence.updateGiven();
    return view(saved);
  }

  function pendingOf(line: QueuedLine): number[] {
    const ids =
      line.about.kind === 'suggestions'
        ? line.about.proposalIds
        : line.about.kind === 'chained'
          ? [line.about.proposalId]
          : [];
    return ids.filter((id) => itemStore.autonomy.proposal(id)?.status === 'pending');
  }

  // Takes a line out of the queue once it has been dealt with, unless that already happened (the
  // gate's change resolved it).
  function settle(queuedId: number, action: 'done' | 'dismiss'): QueuedLine {
    const line = store.line(queuedId);
    if (line?.status === 'queued') return queue.act(queuedId, action);
    return line as QueuedLine;
  }

  function accept(line: QueuedLine): QueuedLine {
    const { about } = line;
    if (about.kind === 'suggestions' || about.kind === 'chained') {
      const pending = pendingOf(line);
      if (!pending.length) return queue.resolve(line.id);
      if (pending.length === 1) gate.accept(pending[0] as number);
      else gate.acceptAll(pending);
      return settle(line.id, 'done');
    }
    if (about.kind === 'autonomy-change') {
      // Worked out again now: the User may have changed the level since it was offered.
      const proposal = itemStore.autonomy.proposal(about.lastProposalId);
      const level = chosenLevel(gate.settings(), {
        action: about.action,
        actionKind: about.actionKind,
        section: proposal?.section ?? about.section,
      });
      const next = stepUp(
        isAllowed(about.actionKind, level) ? level : HARD_LIMITS[about.actionKind],
        about.actionKind,
      );
      if (!next) return queue.resolve(line.id);
      gate.setLevel({ scope: 'action', action: about.action }, next);
      return settle(line.id, 'done');
    }
    throw new Error('There is nothing to accept on that line');
  }

  function act(queuedId: number, action: QueuedAction, snooze?: SnoozeChoice): QueuedLine {
    const line = store.line(queuedId);
    if (!line) throw new Error(`No queued line ${queuedId}`);
    if (line.status !== 'queued') throw new Error(`That line is no longer queued (${line.status})`);
    switch (action) {
      case 'accept':
        return accept(line);
      case 'dismiss':
        // Dismissing the line dismisses what it suggests, too.
        for (const id of pendingOf(line)) gate.dismiss(id);
        return settle(queuedId, 'dismiss');
      case 'snooze':
        return queue.act(queuedId, 'snooze', snooze ?? 'later-today');
      case 'done':
        return queue.act(queuedId, 'done');
    }
  }

  // One of a line's Items, acted on in the Update (#186). The line loses it (and goes once none of its
  // Items is left), unless the gate's change already took care of that.
  function actRow(queuedId: number, itemId: string, action: RowAction): QueuedLine {
    const line = store.line(queuedId);
    if (!line) throw new Error(`No queued line ${queuedId}`);
    if (line.status !== 'queued') throw new Error(`That line is no longer queued (${line.status})`);
    if (!line.itemIds.includes(itemId)) throw new Error('That Item isn’t on this line any more');
    const suggested = pendingOf(line).filter((id) => itemStore.autonomy.proposal(id)?.itemId === itemId);
    switch (action) {
      case 'accept':
        if (!suggested.length) throw new Error('There is nothing to accept on that Item');
        // One at a time: an Act for you suggestion is never accepted in bulk.
        for (const id of suggested) gate.accept(id);
        return withoutRow(queuedId, itemId, 'done');
      case 'dismiss':
        for (const id of suggested) gate.dismiss(id);
        return withoutRow(queuedId, itemId, 'dismiss');
      case 'tick': {
        const todoId = lineContext().todoOf(itemId);
        if (!todoId) throw new Error('That issue has no Todo to tick');
        itemStore.record(
          { type: 'update', itemId: todoId, changes: { status: 'done' } },
          { by: { kind: 'user' }, why: 'Ticked in the Update' },
        );
        return withoutRow(queuedId, itemId, 'done');
      }
      case 'not-an-instruction':
        itemStore.injectionWarnings.clear(itemId, {
          by: { kind: 'user' },
          why: 'Not an instruction aimed at Ares',
        });
        options.onItemsChanged?.([itemId]);
        return withoutRow(queuedId, itemId, 'done');
    }
  }

  function withoutRow(queuedId: number, itemId: string, last: 'done' | 'dismiss'): QueuedLine {
    const line = store.line(queuedId) as QueuedLine;
    if (line.status !== 'queued' || !line.itemIds.includes(itemId)) return line;
    const next = lineWithout(line, itemId, lineContext());
    return next ? queue.revise(queuedId, next) : queue.act(queuedId, last);
  }

  function history(limit = 50): UpdateSummary[] {
    return store.history(limit).map((update) => ({
      id: update.id,
      at: update.at,
      lines: update.lines.length,
      folded: update.folded,
      voice: update.voice,
    }));
  }

  function past(id: number): UpdateView {
    const update = store.update(id);
    if (!update) throw new Error(`No Update ${id}`);
    return view(update);
  }

  // When asking last started a light Teams sync, so asking again soon doesn't wait on another.
  let refreshedAt: number | null = null;

  // Asking for an Update: a light sync of every Teams Account first, waited on for up to 2 seconds,
  // unless Teams was checked in the last 2 minutes.
  async function asked(): Promise<UpdateView | null> {
    const fresh = refreshedAt !== null && now() - refreshedAt < REFRESH_FRESH_MS;
    if (options.refreshTeams && !fresh) {
      refreshedAt = now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.refreshWaitMs ?? REFRESH_WAIT_MS);
      });
      const refreshed = options.refreshTeams().catch((error) => {
        log(`Couldn’t check Teams before the Update: ${error instanceof Error ? error.message : error}`);
      });
      await Promise.race([refreshed, waited]);
      clearTimeout(timer);
    }
    return give();
  }

  function summarise(itemId: string, range: SummaryRange): Promise<ChatSummary> {
    const found = item(itemId);
    if (!found || found.deletedAt !== null) throw new Error('That Chat is no longer in Commander');
    return summariseChat(found, range, {
      client: options.client,
      now,
      me: options.me,
      secrets: options.secrets,
      injectionWarnings: itemStore.injectionWarnings,
      onItemsChanged: options.onItemsChanged,
    });
  }

  async function draft(itemId: string): Promise<ChatDraft> {
    const found = item(itemId);
    if (!found || found.deletedAt !== null) throw new Error('That Chat is no longer in Commander');
    const off =
      decide(
        { action: DRAFT_REPLIES, actionKind: 'organise', section: 'teams', confidence: 1, chained: false },
        gate.settings(),
      ) === 'off';
    if (off) throw new Error('Drafting replies is Off in Settings → Autonomy');
    return draftReply(found, {
      client: options.client,
      now,
      me: options.me,
      secrets: options.secrets,
      injectionWarnings: itemStore.injectionWarnings,
      onItemsChanged: options.onItemsChanged,
    });
  }

  function draftEmail(request: DraftEmailRequest): Promise<ReadyReply> {
    return draftEmailReply(itemStore, request, {
      client: options.client,
      now,
      meaning: options.meaning,
      secrets: options.secrets,
      injectionWarnings: itemStore.injectionWarnings,
      onItemsChanged: options.onItemsChanged,
    });
  }

  const skills = createSkillRegistry();
  skills.register({ ...UPDATE_SKILL, run: () => asked() });
  skills.register<{ itemId: string; range: SummaryRange }, ChatSummary>({
    ...SUMMARISE_SKILL,
    run: ({ itemId, range }) => summarise(itemId, range),
  });
  // Draft takes an Item and, for an email, what the User wants said (#143): a Chat gets a draft for its
  // reply box, an email thread its suggested reply. M7's Conversations call it this way.
  skills.register<{ itemId: string; instruction?: string }, ChatDraft | ReadyReply>({
    ...DRAFT_SKILL,
    run: ({ itemId, instruction }) =>
      item(itemId)?.kind === 'email' ? draftEmail({ itemId, instruction }) : draft(itemId),
  });

  async function answer(raw: unknown): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const parsed = updatesRequest.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `Malformed updates request: ${parsed.error.message}` };
    const request = parsed.data;
    try {
      switch (request.op) {
        case 'state':
          sweep();
          return { ok: true, result: state() };
        case 'run-skill':
          return { ok: true, result: await skills.run(request.skill, undefined) };
        case 'summarise-chat':
          return { ok: true, result: await summarise(request.itemId, request.range) };
        case 'draft-reply':
          return { ok: true, result: await draft(request.itemId) };
        case 'draft-email-reply':
          return {
            ok: true,
            result: await draftEmail({ itemId: request.itemId, instruction: request.instruction }),
          };
        case 'summarise-github':
          if (!options.summariseGitHub) return { ok: false, error: 'Ares isn’t running' };
          return { ok: true, result: await options.summariseGitHub(request.request) };
        case 'refresh-person-paragraph':
          if (!options.refreshPersonParagraph) return { ok: false, error: 'Ares isn’t running' };
          return { ok: true, result: await options.refreshPersonParagraph(request.request) };
        case 'history':
          return { ok: true, result: history(request.limit) };
        case 'past':
          return { ok: true, result: past(request.id) };
        case 'act':
          return { ok: true, result: act(request.queuedId, request.action, request.snooze) };
        case 'act-row':
          return { ok: true, result: actRow(request.queuedId, request.itemId, request.action) };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const timer = setInterval(sweep, SWEEP_EVERY_MS);
  sweep();

  return {
    queue,
    presence,
    skills,
    sweep,
    state,
    give,
    summarise,
    draft,
    draftEmail,
    history,
    past,
    act,
    actRow,

    handle(message) {
      const report = presenceReport.safeParse(message);
      if (report.success) {
        presence.report(report.data satisfies PresenceReport);
        return true;
      }
      const parsed = envelope.safeParse(message);
      if (!parsed.success) return false;
      const { id } = parsed.data;
      void answer((message as { request?: unknown }).request).then((response) =>
        options.send?.({ type: UPDATES_MESSAGES.reply, id, response }),
      );
      return true;
    },

    stop() {
      clearInterval(timer);
    },
  };
}
