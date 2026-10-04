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
// - The Update Skill gives an Update: the queued lines in order, in Ares's words (compose.ts), with
//   the smaller things folded after more than 8 hours away (never after a busy day). Every Update
//   given is kept, so the last one, or any earlier one, can be reopened. Asking for one first runs a
//   light sync of every Teams Account, waiting up to 5 seconds before going on with what's there.
// - The Summarise Skill (#109) summarises a Chat on request, over a range of its messages.
// - Acting on a line: Done and Dismiss take it out of the queue (Dismiss also dismisses the
//   suggestions it is about), Snooze hides it until later, and Accept takes a suggestion in place,
//   through the gate, or raises an action's Autonomy level one step (never past its hard limit).
import {
  type AutonomyLevel,
  autonomyLevels,
  type ChatSummary,
  chosenLevel,
  createSkillRegistry,
  type GivenUpdate,
  HARD_LIMITS,
  isAllowed,
  type PresenceReport,
  presenceReport,
  type QueuedAction,
  type QueuedLine,
  type SkillRegistry,
  type SnoozeChoice,
  SUMMARISE_SKILL,
  type SummaryRange,
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
import { summariseChat } from '../agent/summarise-chat';
import type { Gate } from '../autonomy/gate';
import type { ItemStore } from '../item-store';
import type { KnownSecrets } from '../safety/known-secrets';
import { compose, templateText } from './compose';
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
// How long asking for an Update waits on the light Teams sync before going on with what's there.
const REFRESH_WAIT_MS = 5_000;

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
  // How long asking waits on it before going on (5 seconds; tests shorten it).
  refreshWaitMs?: number;
  // The quiet count or the User's presence changed.
  onState?: (state: UpdatesState) => void;
  // The User stopped being active: the Agent's catch-up work can run.
  onIdle?: () => void;
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
  history(limit?: number): UpdateSummary[];
  past(id: number): UpdateView;
  act(queuedId: number, action: QueuedAction, snooze?: SnoozeChoice): QueuedLine;
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
    onReturn: () => void prepare(),
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
            item,
            secrets: options.secrets,
            injectionWarnings: itemStore.injectionWarnings,
            onItemsChanged: options.onItemsChanged,
            log,
            apart: new Set(lines.filter((line) => line.about.kind === 'chat-summary').map((line) => line.id)),
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

  function view(update: GivenUpdate): UpdateView {
    return { ...update, lines: update.lines.map((line) => ({ ...line, queued: store.line(line.queuedId) })) };
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
    const titleOf = (itemId: string) => item(itemId)?.title ?? null;
    const lead = new Set(worded.map((line) => line.id));
    const given: UpdateLine[] = lines.map((line) => ({
      queuedId: line.id,
      group: line.group,
      kind: line.about.kind,
      text: composed.texts.get(line.id) ?? templateText(line, titleOf),
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

  // Asking for an Update: a light sync of every Teams Account first, waited on for up to 5 seconds.
  async function asked(): Promise<UpdateView | null> {
    if (options.refreshTeams) {
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

  const skills = createSkillRegistry();
  skills.register({ ...UPDATE_SKILL, run: () => asked() });
  skills.register<{ itemId: string; range: SummaryRange }, ChatSummary>({
    ...SUMMARISE_SKILL,
    run: ({ itemId, range }) => summarise(itemId, range),
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
        case 'history':
          return { ok: true, result: history(request.limit) };
        case 'past':
          return { ok: true, result: past(request.id) };
        case 'act':
          return { ok: true, result: act(request.queuedId, request.action, request.snooze) };
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
    history,
    past,
    act,

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
