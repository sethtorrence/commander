// Conversations in the Core (#191, decisions #24, #19, #22). The User talks to Ares in the Ares
// Section; each Conversation is kept in the Item store (item-store/conversations.ts) and runs on its
// own, so a long answer in one never holds up a quick question in another.
//
// - Sending: the User's message is saved as their turn, and Ares answers it on the Deep tier (job
//   `conversation`, its own line on the Usage page; the tier's thinking, or a per-job override, and
//   the monthly cap apply as for every call). Earlier turns go back as the history, within a budget,
//   oldest dropped first (history.ts).
// - Streaming: his answer reaches the window as he writes it, as `conversation-tokens` core messages,
//   after Commander's checks on his words (answer.ts, ADR 0004); his turn as it changes goes as
//   `conversation-turn`. Stop ends an answer early and keeps what he wrote.
// - Several at once: a cloud model answers every Conversation in parallel; a model on this machine
//   answers one at a time, and Conversations take turns (fair-queue.ts), a waiting answer saying so.
// - Failing: no key, the cap, or a failed call leaves his answer `failed` with the reason in his
//   voice; the User's message stays, for Send again.
// - Skills (#192, skills.ts): each turn he may take up to SKILL_STEPS Skill steps before answering,
//   choosing from what the User said (Find, Update, Summarise, from the Skill registry). Each step is
//   a call whose reply names a Skill and its input; Commander runs it and hands him what it found for
//   the next call. Asking for more steps than that, or a Skill failing, has Commander say plainly what
//   he couldn't finish, with whatever the material does show after it. An Update he gives shows in
//   the Conversation with its lines and actions (`updateId`).
// - Acting (#196): his action Skills (Manage Todos, File, Snooze, Linear actions) hand the gate
//   proposals, under the User's Autonomy settings, with this Conversation as their cause. Commander
//   tells each the refs handed out so far and what the call that chose it read from outside, so an
//   action following from outside material is chained (../skills/act.ts). The proposals are kept on
//   the answer (`proposalIds`) and show under it as cards: done, with Undo, or waiting for the User to
//   confirm with one key. Accepting one never starts anything further. Changing his own settings
//   (#197) always waits for the User, and only ever from words of theirs Commander finds in what they
//   wrote here (../skills/change-settings.ts).
// - Links: every Item handed to him has a ref (I1, I2…) for this answer; his answer names the ones
//   its claims rest on, which become its links (`links`), each opening its Item in its Section. A ref
//   he wasn't handed is taken out of his text.
// - Trust: what the User typed is their own material (prompt.ts, buildConversationPrompt). What his
//   Skills found goes in data blocks after it: each Item from a Source as outside material in a block
//   of its own, the User's Daily Notes and confirmed Memory as theirs, the rest as background. A
//   steering flag in any reply marks an Item only with a quote found in it (ADR 0004). He never
//   starts a Conversation or writes into one unprompted: every turn of his answers one of the User's,
//   which the Item store enforces.
// - Remembering (#194, remember.ts): what the User tells him about themselves, their work and the
//   people in it becomes confirmed Memory, with their turn as its source, learned by a call of its
//   own beside his answer that reads only the User's words (never an Item, nor his answers). What
//   changed shows as lines under his answer (`remembered`), each with Undo; Send again keeps them.
//   With every message, the confirmed memories about what the User said come back to him as theirs.
// - About an Item (#193, about.ts): a Conversation started with the Ares button on an Item is named
//   after it, and that Item is handed to him with every message as I1, in a data block of its own by
//   where it came from, before anything his Skills find. Whatever it leads to is still only an answer
//   (and, once he can act, a proposal through the gate like any other).
import {
  ABOUT_REF,
  CONVERSATIONS_MESSAGES,
  type Conversation,
  type ConversationsOp,
  type ConversationsResults,
  type ConversationTurn,
  type ConversationView,
  type CoreMessage,
  conversationsRequest,
  type Item,
  LINK_REF,
  type ModelSettings,
  type Remembered,
  SkillInputError,
  type SkillRegistry,
  SUMMARISE_SKILL,
  skillTitle,
  titleFrom,
} from '@commander/domain';
import { type ModelClient, ModelError } from '@commander/models';
import { z } from 'zod';
import { buildConversationPrompt, type PromptData, PromptRefused } from '../agent/prompt';
import type {
  ConversationStore,
  InjectionWarningStore,
  RefusalStore,
  RemovedConversation,
} from '../item-store';
import type { KnownSecrets } from '../safety/known-secrets';
import { heedRefusal } from '../safety/refusal';
import { heedSteering, type SteeringFlag } from '../safety/steering-flag';
import { type AboutReading, aboutOf } from './about';
import { type AnswerReader, pieceBetween, readAnswer } from './answer';
import { createFairQueue, type QueueTicket } from './fair-queue';
import { HISTORY_BUDGET_CHARS, historyOf, historyWithin } from './history';
import type { Rememberer } from './remember';
import {
  COULDNT_FINISH,
  findingsOf,
  type Gathered,
  gather,
  gatheredAnything,
  handedLinks,
  handedRefs,
  linksIn,
  materialOf,
  nothingGathered,
  offeredSkills,
  readChoice,
  SKILL_STEPS,
} from './skills';
import { conversationInstructions, type Stage } from './voice';

export { createFairQueue, type FairQueue, type QueueTicket } from './fair-queue';
export { HISTORY_BUDGET_CHARS, historyOf, historyWithin } from './history';
export { CONVERSATION_SKILLS, COULDNT_FINISH, SKILL_STEPS } from './skills';

// The usage ledger's name for a Conversation's calls (AGENT_JOB_NAMES: "Conversations").
export const CONVERSATION_JOB = 'conversation';

// How often what he has written so far goes to the window.
const FLUSH_MS = 50;
// How long a deleted Conversation can be put back (the toast shows for 12 seconds).
const UNDO_MS = 60_000;

/** Whether a model is served on this machine (a loopback address), so it answers one thing at a time. */
export function servedOnThisMachine(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127\./.test(host) ||
    host === '0.0.0.0'
  );
}

/** Why an answer a stopped Core was writing failed (#200), in Ares's voice. */
export const UNFINISHED_PROBLEM =
  'Commander’s core stopped while I was answering, so I didn’t finish. Send this again.';

/**
 * Why an answer failed, in Ares's voice. Never the provider's own words. `aboutItemId`: the Item the
 * Conversation was started from (#193), if any.
 */
export function problemFor(error: unknown, aboutItemId: string | null = null): string {
  // The Item the Conversation is about held it (#201): it is noted as skipped, where it is.
  if (error instanceof PromptRefused && aboutItemId && error.itemIds.includes(aboutItemId)) {
    return 'What you started this from holds what looks like one of your keys or sign-in tokens, so I didn’t send it anywhere. Open it yourself instead.';
  }
  // Something a Skill found held it (#201): that Item is noted as skipped, where it is.
  if (error instanceof PromptRefused && error.itemIds.length) {
    return 'Something my Skills found holds what looks like one of your keys or sign-in tokens, so I didn’t send it anywhere. Ask without it, or open it yourself.';
  }
  if (error instanceof PromptRefused) {
    return 'Your message held one of your sign-in tokens or keys, so I didn’t send it anywhere. Take it out, then send it again.';
  }
  const kind = error instanceof ModelError ? error.kind : 'unavailable';
  switch (kind) {
    case 'no-key':
      return 'I can’t answer yet: there’s no model key saved. Add one in Settings → Ares, then send this again.';
    case 'over-cap':
      return 'This month’s model spend has reached your cap, so I’m holding off until next month. You can raise the cap in Settings → Ares, then send this again.';
    case 'auth':
      return 'The model provider turned down the key. Check it in Settings → Ares, then send this again.';
    case 'billing':
      return 'The model provider account is out of credit. Once it’s topped up, send this again.';
    case 'rate-limit':
      return 'The model provider is turning requests away for now. Give it a minute, then send this again.';
    case 'timeout':
      return 'The model took too long to answer. Send this again in a moment.';
    default:
      return 'I couldn’t get an answer from the model just now. Send this again in a moment.';
  }
}

export type ConversationsOptions = {
  store: ConversationStore;
  client: ModelClient;
  // The model settings, read for each answer: whether the Deep tier's model is on this machine.
  settings: () => ModelSettings;
  // The tokens and keys the Core holds: a message holding one is never sent.
  secrets?: KnownSecrets;
  // Replies to the window's requests, and the streamed answers (core messages).
  send: (message: unknown) => void;
  now?: () => number;
  // Whether the Deep tier's model answers one thing at a time (on this machine); worked out from its
  // base URL unless given (the end-to-end tests treat their fake model as a cloud one).
  oneAtATime?: () => boolean;
  historyBudget?: number;
  // Ares's Skills (#192): those a Conversation can use are offered to him; all are listed on "What
  // Ares can do". None: he has no Skills, and answers from his own knowledge.
  skills?: SkillRegistry;
  // Items by id, for what an Update's lines are about, and the Item a Conversation is started from.
  item?: (itemId: string) => Item | null;
  // Reads the Item a Conversation is about for each message (#193, about.ts). None: it isn't handed.
  readAbout?: (itemId: string) => AboutReading;
  // Where a steering flag marks an Item, and who hears that it did.
  injectionWarnings?: Pick<InjectionWarningStore, 'flag'>;
  // Where an Item a Skill found, left unsent for holding a key or token, is noted as skipped (#201).
  refusals?: Pick<RefusalStore, 'record'>;
  onItemsChanged?: (itemIds: string[]) => void;
  // What the User tells him becomes Memory (#194, remember.ts). None: nothing is remembered.
  remember?: Rememberer;
  // The confirmed memories about what the User said (#194), handed to him with their message as theirs.
  recall?: (text: string) => PromptData[] | Promise<PromptData[]>;
  log?: (message: string) => void;
};

export type Conversations = {
  // A message from the main process. True when it was ours.
  handle(message: unknown): boolean;
  // Answers in progress stop, keeping what he wrote (Commander is closing).
  stop(): void;
};

type Answering = {
  turnId: number;
  controller: AbortController;
  ticket: QueueTicket | null;
  finished: Promise<void>;
  // What he has written so far, checked.
  partial: () => string;
  // What he remembered from the User's message was carried over from an answer Send again replaced.
  remembered: boolean;
};

const envelope = z.object({
  type: z.literal(CONVERSATIONS_MESSAGES.request),
  id: z.number().int().positive(),
});

export function setUpConversations(options: ConversationsOptions): Conversations {
  const { store, client } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  const budget = options.historyBudget ?? HISTORY_BUDGET_CHARS;
  const oneAtATime = options.oneAtATime ?? (() => servedOnThisMachine(options.settings().tiers.deep.baseUrl));
  const queue = createFairQueue({ capacity: () => (oneAtATime() ? 1 : Number.POSITIVE_INFINITY) });
  // Commander is closing: what is being written was saved by stop(), and nothing touches the store.
  let closed = false;
  const answering = new Map<string, Answering>();
  const removed = new Map<
    string,
    { conversation: RemovedConversation; timer: ReturnType<typeof setTimeout> }
  >();

  // Answers the last Core was writing when it stopped without closing (#200; closing stops them
  // itself): failed, so the User can send their message again.
  store.settleUnfinished(UNFINISHED_PROBLEM);

  const push = (message: CoreMessage) => options.send(message);
  const changed = (turn: ConversationTurn) => push({ type: 'conversation-turn', turn });

  // Marks the outside Items a reply's steering flag names with a quote found in them.
  function heed(flag: SteeringFlag, outside: { ref: string; itemId: string }[]) {
    const marked = heedSteering(flag, { outside }, options.injectionWarnings);
    if (marked.length) options.onItemsChanged?.(marked);
  }

  // What the User told him in their message `replyTo` (#194): learned beside his answer, from their
  // words alone, and shown under it (`turnId`) as lines with Undo. Never holds his answer up.
  function learnFrom(view: ConversationView, replyTo: number, turnId: number, signal: AbortSignal) {
    const remember = options.remember;
    if (!remember) return;
    const theirs = view.turns.filter((turn) => turn.by === 'user' && turn.id <= replyTo);
    const said = theirs.at(-1);
    if (said?.id !== replyTo) return;
    const heldHere = view.turns.flatMap((turn) =>
      turn.remembered.filter((line) => !line.undone && line.did !== 'forgot').map((line) => line.memoryId),
    );
    remember
      .learn({
        conversationId: view.conversation.id,
        turnId: replyTo,
        said: said.text,
        earlier: theirs.slice(0, -1).map((turn) => turn.text),
        heldHere: [...new Set(heldHere)],
        signal,
      })
      .then((lines) => {
        if (closed || !lines.length) return;
        changed(store.saveAnswer(turnId, { remembered: lines }));
      })
      .catch((error: unknown) => {
        if (closed || signal.aborted || error instanceof ModelError || error instanceof PromptRefused) return;
        log(`Ares couldn’t remember what the User said: ${error instanceof Error ? error.message : error}`);
      });
  }

  // The confirmed memories about what the User said, for every call answering it; none if the lookup fails.
  async function recalled(text: string | undefined): Promise<PromptData[]> {
    if (!options.recall || !text) return [];
    try {
      return await options.recall(text);
    } catch (error) {
      log(`Couldn’t recall Memory for a Conversation: ${error instanceof Error ? error.message : error}`);
      return [];
    }
  }

  // Ares writes his answer to the User's turn `replyTo`: up to SKILL_STEPS Skill steps first, each a
  // call whose reply names a Skill, then the answer itself, read, checked and sent to the window as it
  // comes, and saved with what it rests on.
  async function write(conversationId: string, replyTo: number, entry: Answering) {
    const { turnId, controller } = entry;
    if (controller.signal.aborted) return;
    changed(store.saveAnswer(turnId, { status: 'streaming' }));
    const view = store.view(conversationId);
    const gathered: Gathered = nothingGathered();
    // The Item it was started from (#193): handed first, as I1, read as it is now.
    const aboutItemId = view?.conversation.aboutItemId ?? null;
    const about = aboutItemId ? (options.readAbout?.(aboutItemId) ?? null) : null;
    if (about) {
      gathered.notes.push(about.note);
      if (about.found) gathered.items.set(ABOUT_REF, about.found);
    }
    let sent = '';
    let reader: AnswerReader | null = null;
    // Commander's own words before his: what he couldn't finish.
    let lead: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = (text: string) => {
      if (text === sent) return;
      const piece = pieceBetween(sent, text);
      sent = text;
      push({ type: 'conversation-tokens', conversationId, turnId, ...piece });
    };
    // His answer as far as it has got, checked, with only the links he was handed.
    const soFar = () => {
      const text = reader && reader.grounds() !== 'skill' ? reader.final() : (lead ?? '');
      return linksIn(text, gathered);
    };
    const ownKnowledge = (text: string) => {
      const grounds = reader?.grounds();
      if (!text || grounds === 'skill') return false;
      return grounds === 'general' || (grounds === null && !gatheredAnything(gathered));
    };
    // What he rests on so far, for the window: the Skills he used, the Items handed out, the Update.
    const resting = () => ({
      skills: [...gathered.skills],
      links: handedLinks(gathered),
      updateId: gathered.update?.id ?? null,
      proposalIds: [...gathered.proposalIds],
    });
    // What the User asked, for an action's reason, and everything they wrote up to it: where a change to
    // Ares's own settings must find the words that asked for it (#197).
    const asked = view?.turns.find((turn) => turn.id === replyTo)?.text;
    const said = (view?.turns ?? [])
      .filter((turn) => turn.by === 'user' && turn.id <= replyTo)
      .map((turn) => turn.text);
    entry.partial = () => soFar().text;
    if (view && !entry.remembered) learnFrom(view, replyTo, turnId, controller.signal);
    try {
      if (!view) throw new Error('That Conversation is no longer in Commander');
      const known = await recalled(asked);
      const turns = historyWithin(historyOf(view.turns, replyTo), budget);
      const offered = options.skills ? offeredSkills(options.skills) : [];
      let stepsLeft = SKILL_STEPS;
      let stage: Stage = offered.length ? { kind: 'choosing', stepsLeft } : { kind: 'last' };
      for (;;) {
        const prompt = buildConversationPrompt(
          {
            instructions: conversationInstructions(offered, stage),
            turns,
            data: [...materialOf(gathered), ...known],
          },
          { secrets: options.secrets },
        );
        const live = readAnswer(prompt.material, lead ? { lead } : {});
        reader = live;
        const stream = client.complete({
          tier: 'deep',
          job: CONVERSATION_JOB,
          messages: prompt.messages,
          stream: true,
          signal: controller.signal,
        });
        for await (const token of stream) {
          live.add(token);
          if (live.grounds() === 'skill') continue;
          timer ??= setTimeout(() => {
            timer = null;
            flush(live.text());
          }, FLUSH_MS);
        }
        await stream.done;
        heed(live.steering(), prompt.outside);
        if (live.grounds() !== 'skill') break;
        // A Skill step.
        if (stage.kind === 'wrap-up') break;
        // He wanted more steps than he may take: Commander says so, and he goes on with what he has.
        if (stage.kind === 'last') {
          lead = COULDNT_FINISH.steps;
          stage = { kind: 'wrap-up', said: lead };
          if (gatheredAnything(gathered)) continue;
          break;
        }
        const picked = readChoice(live.request(), offered);
        stepsLeft -= 1;
        stage = stepsLeft > 0 ? { kind: 'choosing', stepsLeft } : { kind: 'last' };
        if (!picked.ok) {
          gathered.notes.push(`Your last Skill request couldn’t be used: ${picked.why}.`);
          continue;
        }
        heed(picked.choice.steering, prompt.outside);
        const { skill } = picked.choice;
        let input = picked.choice.input;
        // Summarise on an Item he was shown: its ref, as the Item itself.
        const target = (input as { target?: unknown } | null)?.target;
        if (skill === SUMMARISE_SKILL.name && typeof target === 'string' && LINK_REF.test(target.trim())) {
          const found = gathered.items.get(target.trim());
          if (found) input = { ...(input as object), target: `item:${found.item.id}` };
        }
        changed(store.saveAnswer(turnId, { ...resting(), skills: [...gathered.skills, skill] }));
        let output: unknown;
        try {
          output = await (options.skills as SkillRegistry).run(skill, input, {
            conversation: { conversationId, turnId },
            ...(asked !== undefined && { asked }),
            said,
            refs: handedRefs(gathered),
            read: {
              outside: prompt.outside.map((block) => block.itemId),
              background: prompt.background?.itemIds ?? null,
            },
          });
          if (controller.signal.aborted) throw new ModelError('cancelled', 'Stopped.');
          gather(gathered, skill, findingsOf(skill, output, options.item ?? (() => null)));
        } catch (error) {
          if (controller.signal.aborted) throw error;
          // What he gave it didn't fit what it needs: nothing ran, and he is told, as for a malformed request.
          if (error instanceof SkillInputError) {
            gathered.notes.push(`Your last Skill request couldn’t be used: ${error.message}.`);
            changed(store.saveAnswer(turnId, resting()));
            continue;
          }
          log(`Ares’s ${skill} Skill failed: ${error instanceof Error ? error.message : error}`);
          gathered.skills.push(skill);
          changed(store.saveAnswer(turnId, resting()));
          // A Skill failed: Commander says so, and he goes on with what the others found, if anything.
          lead = COULDNT_FINISH.failed(skillTitle({ name: skill }));
          stage = { kind: 'wrap-up', said: lead };
          if (gatheredAnything(gathered)) continue;
          break;
        }
        changed(store.saveAnswer(turnId, resting()));
      }
      const { text, links } = soFar();
      flush(text);
      changed(
        store.saveAnswer(turnId, {
          ...resting(),
          status: 'done',
          text,
          links,
          ownKnowledge: ownKnowledge(text),
          endedAt: now(),
        }),
      );
    } catch (error) {
      if (closed) return;
      const { text, links } = soFar();
      flush(text);
      const rests = { ...resting(), links, ownKnowledge: ownKnowledge(text) };
      if (controller.signal.aborted) {
        changed(store.saveAnswer(turnId, { ...rests, status: 'stopped', text, endedAt: now() }));
      } else {
        if (!(error instanceof ModelError) && !(error instanceof PromptRefused)) {
          log(`A Conversation’s answer failed: ${error instanceof Error ? error.message : error}`);
        }
        if (error instanceof PromptRefused)
          heedRefusal(error, 'Conversation', options.refusals, options.onItemsChanged);
        changed(
          store.saveAnswer(turnId, {
            ...rests,
            status: 'failed',
            text,
            problem: problemFor(error, aboutItemId),
            endedAt: now(),
          }),
        );
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Ares starts answering the User's last turn, now or when it is this Conversation's turn. `carried`:
  // what he remembered from it in the answer Send again replaced, kept rather than learned again.
  function answer(conversationId: string, replyTo: number, carried: Remembered[] = []) {
    let turn = store.startAnswer(conversationId, replyTo, 'queued');
    if (carried.length) turn = store.saveAnswer(turn.id, { remembered: carried });
    const controller = new AbortController();
    let done: () => void = () => {};
    const entry: Answering = {
      turnId: turn.id,
      controller,
      ticket: null,
      finished: new Promise<void>((resolve) => {
        done = resolve;
      }),
      partial: () => '',
      remembered: carried.length > 0,
    };
    answering.set(conversationId, entry);
    entry.ticket = queue.enqueue(conversationId, async () => {
      try {
        await write(conversationId, replyTo, entry);
      } catch (error) {
        log(`Couldn’t save a Conversation’s answer: ${error instanceof Error ? error.message : error}`);
      } finally {
        if (answering.get(conversationId) === entry) answering.delete(conversationId);
        done();
      }
    });
    // Waiting its turn on a model on this machine: the window says so.
    if (entry.ticket.waiting()) changed(store.turn(turn.id) as ConversationTurn);
  }

  // Stop: a waiting answer comes out of the queue; one being written ends, keeping what he wrote.
  async function stopAnswer(conversationId: string) {
    const entry = answering.get(conversationId);
    if (!entry) return;
    if (entry.ticket?.cancel()) {
      answering.delete(conversationId);
      changed(store.saveAnswer(entry.turnId, { status: 'stopped', endedAt: now() }));
      return;
    }
    entry.controller.abort();
    await entry.finished;
  }

  // A Conversation for the window, naming the Item it was started from as that Item is now.
  function described(conversation: Conversation): Conversation {
    if (!conversation.aboutItemId) return conversation;
    const item = options.item?.(conversation.aboutItemId);
    return { ...conversation, about: item && item.deletedAt === null ? aboutOf(item) : null };
  }
  const shown = (view: ConversationView): ConversationView => ({
    ...view,
    conversation: described(view.conversation),
  });

  function required(conversationId: string): ConversationView {
    const view = store.view(conversationId);
    if (!view) throw new Error('That Conversation is no longer in Commander');
    return shown(view);
  }

  // New Conversation, or one started from an Item (#193): named after the Item, which must be here.
  function create(day: string, aboutItemId: string | undefined): ConversationView {
    if (!aboutItemId) return shown(store.create(day));
    const item = options.item?.(aboutItemId);
    if (!item || item.deletedAt !== null) throw new Error('That Item is no longer in Commander');
    return shown(store.create(day, { itemId: item.id, title: titleFrom(item.title) }));
  }

  async function run(
    request: z.output<typeof conversationsRequest>,
  ): Promise<ConversationsResults[ConversationsOp]> {
    switch (request.op) {
      case 'list':
        return store.list().map(described);
      case 'today':
        return shown(store.today(request.day));
      case 'new':
        return create(request.day, request.about);
      case 'open':
        return required(request.conversationId);
      case 'send': {
        const turn = store.addUserTurn(request.conversationId, request.text);
        answer(request.conversationId, turn.id);
        return required(request.conversationId);
      }
      case 'retry': {
        if (answering.has(request.conversationId)) throw new Error('Ares is still answering');
        const replaced = store.view(request.conversationId)?.turns.at(-1);
        const asked = store.takeBack(request.conversationId);
        answer(request.conversationId, asked.id, replaced?.by === 'ares' ? replaced.remembered : []);
        return required(request.conversationId);
      }
      case 'stop':
        await stopAnswer(request.conversationId);
        return required(request.conversationId);
      case 'delete': {
        await stopAnswer(request.conversationId);
        const conversation = store.remove(request.conversationId);
        const timer = setTimeout(() => removed.delete(request.conversationId), UNDO_MS);
        timer.unref?.();
        removed.set(request.conversationId, { conversation, timer });
        return { conversationId: request.conversationId };
      }
      case 'undo-delete': {
        const kept = removed.get(request.conversationId);
        if (!kept) throw new Error('That Conversation can’t be put back any more');
        clearTimeout(kept.timer);
        removed.delete(request.conversationId);
        return shown(store.restore(kept.conversation));
      }
      case 'undo-remembered': {
        // Undo on a line under his answer (#194): the memory as it was before the User's message.
        const answered = store.turn(request.turnId);
        if (answered?.conversationId !== request.conversationId || answered.replyTo === null)
          throw new Error('That answer is no longer in Commander');
        const line = answered.remembered.find((each) => each.memoryId === request.memoryId);
        if (!line) throw new Error('Ares didn’t remember that in this answer');
        if (line.undone) return answered;
        if (!options.remember) throw new Error('Ares can’t change what he remembers here');
        options.remember.undo(line.memoryId, {
          conversationId: request.conversationId,
          turnId: answered.replyTo,
        });
        const saved = store.saveAnswer(answered.id, {
          remembered: answered.remembered.map((each) =>
            each.memoryId === line.memoryId ? { ...each, undone: true } : each,
          ),
        });
        changed(saved);
        return saved;
      }
      case 'skills': {
        // Every Skill he has, and whether a Conversation can use it yet.
        const offered = new Set(
          options.skills ? offeredSkills(options.skills).map((skill) => skill.name) : [],
        );
        return (options.skills?.list() ?? []).map((skill) => ({
          ...skill,
          inConversations: offered.has(skill.name),
        }));
      }
    }
  }

  async function reply(id: number, raw: unknown) {
    const parsed = conversationsRequest.safeParse(raw);
    let response: { ok: true; result: unknown } | { ok: false; error: string };
    if (!parsed.success)
      response = { ok: false, error: `Malformed conversations request: ${parsed.error.message}` };
    else {
      try {
        response = { ok: true, result: await run(parsed.data) };
      } catch (error) {
        response = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    options.send({ type: CONVERSATIONS_MESSAGES.reply, id, response });
  }

  return {
    handle(message) {
      const parsed = envelope.safeParse(message);
      if (!parsed.success) return false;
      void reply(parsed.data.id, (message as { request?: unknown }).request);
      return true;
    },

    stop() {
      closed = true;
      // Commander is closing: each answer is saved as far as he got, before the store closes.
      for (const entry of answering.values()) {
        entry.ticket?.cancel();
        entry.controller.abort();
        const text = entry.partial();
        store.saveAnswer(entry.turnId, { status: 'stopped', text, endedAt: now() });
      }
      answering.clear();
      for (const { timer } of removed.values()) clearTimeout(timer);
      removed.clear();
    },
  };
}
