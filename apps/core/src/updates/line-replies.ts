// Replying to an Update line (#236, decision #24). The Reply box on a line starts a Conversation about
// it (../conversations), and with every message there Ares is handed the line as the Update builds it,
// read afresh:
//
// - Its facts, in Commander's own words (kinds/), in a block of their own, as "Put Updates together"
//   is handed them (ADR 0004, seventh amendment). A Bucket Ares suggests is his own name and reason,
//   picked up from outside content, so that line's facts go in as background.
// - Its Items, each read (its facts and words, as a Skill reads an Item) in a block of its own, its
//   trust from where it came from, with a ref (I1, I2…) and where it stands on the line. Not the
//   Items of a line about refusals (they hold one of the User's keys: exactly what must not reach a
//   model), nor mail Ares may not read yet, nor his own (a meeting's prep, a GitHub summary). What in
//   an Item read like an instruction (a warning's quote) is shown to the User and never handed back.
// - Commander's note: what the Conversation is about, where the line stands (waiting, snoozed, done,
//   dismissed, settled elsewhere, expired), and what it offers now.
//
// The line Skill prepares one of the line's own actions (its buttons, or one of its Items') as a card
// under his answer, which only the User's Confirm carries out, by the same path as the button (the
// window's Update actions). He can never act on the line himself. A line no longer waiting offers
// nothing, and Send now and Discard (a missed send-later's) stay the User's own buttons.
import {
  type ConversationAboutLine,
  type ConversationMade,
  type Item,
  LINE_SKILL,
  LINE_SKILL_NEEDS,
  type LineActionName,
  type LineSkillInput,
  lineItemActions,
  lineSkillInput,
  mayReadMail,
  type QueuedAction,
  type QueuedLine,
  type Skill,
  type SkillContext,
  SkillInputError,
  type SnoozeChoice,
  UPDATE_GROUP_NAMES,
  type UpdateRow,
} from '@commander/domain';
import type { PromptData } from '../agent/prompt';
import type { ItemStore } from '../item-store';
import { type Findings, type FoundItem, findable } from '../skills/findings';
import { readItem } from '../skills/read-item';
import { kindName, type LineContext, lineFacts, lineRows } from './kinds';
import { clock, dayWord, labelOf, titleOf } from './kinds/words';

// At most this many of a line's Items are handed to Ares, as "Put Updates together" hands them.
export const MAX_LINE_ITEMS = 8;

/** What Ares is handed of the line a Conversation is about, for each message. */
export type LineReading = {
  // Commander's own words: what the Conversation is about, where the line stands, what it offers.
  note: string;
  // The line's facts block (none once the line has gone).
  facts: PromptData | null;
  // Its Items, read, in the line's order: handed as I1, I2…
  items: FoundItem[];
};

/** What a line offers now: its own actions, and each of its Items', by Item. */
export type LineOffers = { line: QueuedAction[]; items: Map<string, LineActionName[]> };

const ACCEPT_IN_BULK = new Set(['organise', 'tidy-sources']);

type Context = {
  itemStore: Pick<ItemStore, 'get' | 'models' | 'projects' | 'emailBody' | 'autonomy' | 'updates'>;
  context: () => LineContext;
};

// The suggestions still waiting on a line about suggestions.
function waitingOn(line: QueuedLine, itemStore: Context['itemStore']) {
  const ids =
    line.about.kind === 'suggestions'
      ? line.about.proposalIds
      : line.about.kind === 'chained'
        ? [line.about.proposalId]
        : [];
  return ids.flatMap((id) => {
    const proposal = itemStore.autonomy.proposal(id);
    return proposal?.status === 'pending' ? [proposal] : [];
  });
}

/** Whether the line itself can be accepted in place, as its Accept button does (the window's acceptLabel). */
function acceptable(line: QueuedLine, itemStore: Context['itemStore']): boolean {
  const { about } = line;
  switch (about.kind) {
    case 'suggestions': {
      const waiting = waitingOn(line, itemStore);
      return waiting.length === 1 || (waiting.length > 1 && ACCEPT_IN_BULK.has(about.actionKind));
    }
    case 'chained':
      return waitingOn(line, itemStore).length > 0;
    case 'autonomy-change':
    case 'rule-suggestion':
    case 'bucket-rule-suggestion':
    case 'bucket-suggestion':
      return true;
    default:
      return false;
  }
}

/** The line's Items as the Update lists them now. */
function rowsOf(line: QueuedLine, context: LineContext): UpdateRow[] {
  return lineRows(line, line.itemIds, context, { waiting: line.status === 'queued' });
}

/** What a line offers now, as its buttons and its Items' do: nothing once it is no longer waiting. */
export function lineOffers(line: QueuedLine, { itemStore, context }: Context): LineOffers {
  if (line.status !== 'queued') return { line: [], items: new Map() };
  const own: QueuedAction[] = ['done', 'dismiss', 'snooze'];
  if (acceptable(line, itemStore)) own.push('accept');
  if (line.about.kind === 'couldnt-sync') own.push('retry');
  const offered = new Set<string>(lineItemActions);
  const items = new Map(
    rowsOf(line, context()).flatMap((row): [string, LineActionName[]][] =>
      row.settled
        ? []
        : [[row.itemId, row.actions.filter((action) => offered.has(action)) as LineActionName[]]],
    ),
  );
  return { line: own, items };
}

/** Where the line stands, in Commander's words for Ares. */
export function standing(line: QueuedLine | null, now: number): string {
  if (!line) return 'The line is no longer in Commander, so nothing can be done on it here.';
  const at = (when: number | null) => (when === null ? '' : ` (${clock(when)} ${dayWord(when, now)})`);
  switch (line.status) {
    case 'queued':
      return line.snoozedUntil !== null && line.snoozedUntil > now
        ? `The User snoozed the line until ${clock(line.snoozedUntil)} ${dayWord(line.snoozedUntil, now)}: it is still waiting in their Update.`
        : 'The line is still waiting in the User’s Update.';
    case 'done':
      return `The User marked the line done${at(line.settledAt)}, so it offers nothing any more.`;
    case 'dismissed':
      return `The User dismissed the line${at(line.settledAt)}, so it offers nothing any more.`;
    case 'resolved':
      return `What the line was about was settled elsewhere${at(line.settledAt)}, so it offers nothing any more.`;
    case 'expired':
      return `The line expired${at(line.settledAt)}: what it was about stopped mattering, so it offers nothing any more.`;
  }
}

/** What the line offers, in Commander's words for Ares, naming its Items by their refs. */
function offersNote(offers: LineOffers, refOf: (itemId: string) => string | null): string {
  if (!offers.line.length) return '';
  const items = [...offers.items].flatMap(([itemId, actions]) => {
    const ref = refOf(itemId);
    return ref && actions.length ? [`${ref}: ${actions.join(', ')}`] : [];
  });
  return ` The line offers ${offers.line.join(', ')}, and open${items.length ? `; its Items offer ${items.join('; ')}` : ''}. When the User asks for one of these (“Dana’s handling it” means they are done with it; “remind me tomorrow” means snooze until tomorrow), prepare it with the line Skill: a card the User confirms with one key, which does exactly what the line’s button does. Nothing happens until they confirm, so never say it has.`;
}

/** Reads the line a Conversation is about, for each message, as Ares may see it. */
export function readLine(about: ConversationAboutLine, options: Context): LineReading {
  const { itemStore } = options;
  const context = options.context();
  const line = itemStore.updates.line(about.queuedId);
  const lead =
    'The User started this Conversation from one line of their Update, with the line’s Reply box: what they write here is about that line, and context for what to do with it. When they say “this” or “it”, they mean the line or its Items.';
  if (!line) return { note: `${lead} ${standing(null, context.now)}`, facts: null, items: [] };

  const mayRead = (item: Item) => mayReadMail(itemStore.models.settings(), item.source, item.account);
  const projectCode = (projectId: string) =>
    itemStore.projects({ includeArchived: true }).find((project) => project.id === projectId)?.code ?? null;
  const emailText = (itemId: string) => itemStore.emailBody(itemId)?.text ?? null;
  const rows = new Map(rowsOf(line, context).map((row) => [row.itemId, row]));
  // A line about refusals: its Items hold one of the User's keys or tokens, so none is handed.
  const refused = line.about.kind === 'refusals';
  const held = refused
    ? []
    : line.itemIds.flatMap((itemId) => {
        const item = context.item(itemId);
        return item && findable(item, mayRead) ? [item] : [];
      });
  const handed = held.slice(0, MAX_LINE_ITEMS);
  const items: FoundItem[] = handed.map((item) => {
    const row = rows.get(item.id);
    const state = row ? [`Where it stands on the line: ${row.state}`] : [];
    return { item, text: [readItem(item, { emailText, projectCode }), ...state].join('\n') };
  });
  const refs = new Map(handed.map((item, index) => [item.id, `I${index + 1}`]));

  const notHanded = line.itemIds.length - handed.length;
  const itemsNote = refused
    ? ' Its Items hold what looks like one of the User’s keys or sign-in tokens, so none of them is handed to you.'
    : handed.length
      ? ` Its Items are handed to you as ${handed.length === 1 ? 'I1' : `I1 to I${handed.length}`}.${notHanded > 0 ? ` ${notHanded} more of them aren’t: mail you may not read yet, something of your own, or more than you are handed at once.` : ''}`
      : notHanded > 0
        ? ' Its Items aren’t handed to you: mail you may not read yet, or something of your own.'
        : '';
  const offers = lineOffers(line, options);
  const note = `${lead} Its facts, in Commander’s words, are in the block labelled “The Update line”.${itemsNote} ${standing(line, context.now)}${offersNote(offers, (itemId) => refs.get(itemId) ?? null)}`;

  // A Bucket Ares suggests is his own name and reason, picked up from outside content: background.
  const facts: PromptData = {
    label: `The Update line · ${UPDATE_GROUP_NAMES[line.group]} · ${kindName(line.about)}`,
    from: line.about.kind === 'bucket-suggestion' ? { background: [] } : 'user-settings',
    text: lineFacts(line, context).join('\n'),
  };
  return { note, facts, items };
}

/** The card's words, in Commander's own: what Confirm does. Items by their Source's short name or title. */
export function lineActionWhat(
  line: QueuedLine,
  action: LineActionName,
  {
    item,
    snooze,
    now,
    waiting,
  }: { item: Item | null; snooze: SnoozeChoice | null; now: number; waiting: number },
): string {
  const name = item ? nameFor(item) : '';
  if (item) {
    switch (action) {
      case 'open':
        return `Open ${name}`;
      case 'reply':
        return `Open ${name} at the message waiting on you`;
      case 'accept':
        return `Accept the suggestion on ${name}`;
      case 'dismiss':
        return line.about.kind === 'suggestions' || line.about.kind === 'chained'
          ? `Dismiss the suggestion on ${name}`
          : `Take ${name} off the line`;
      case 'tick':
        return `Tick the Todo for ${name}`;
      case 'not-an-instruction':
        return `Clear the warning mark on ${name}: Not an instruction`;
      case 'edit':
        return `Open ${name} in the composer`;
      case 'retry':
        return `Retry the changes to ${name} that couldn’t sync`;
      default:
        break;
    }
  }
  switch (action) {
    case 'done':
      return 'Mark the line done';
    case 'dismiss':
      return waiting
        ? `Dismiss the line, and the ${waiting === 1 ? 'suggestion' : `${waiting} suggestions`} on it`
        : 'Dismiss the line';
    case 'snooze':
      return snooze === 'tomorrow'
        ? 'Snooze the line until tomorrow at 9:00'
        : `Snooze the line until later today (${clock(now + 3 * 60 * 60_000)})`;
    case 'open':
      return 'Open what the line is about';
    case 'accept':
      return acceptWords(line, waiting);
    case 'retry':
      return 'Retry the changes that couldn’t sync';
    default:
      return 'Act on the line';
  }
}

function acceptWords(line: QueuedLine, waiting: number): string {
  switch (line.about.kind) {
    case 'suggestions':
      return waiting > 1 ? `Accept all ${waiting} suggestions` : 'Accept the suggestion';
    case 'chained':
      return 'Accept the suggestion';
    case 'autonomy-change':
      return `Let Ares just do “${line.about.name}” (one step up)`;
    case 'rule-suggestion':
    case 'bucket-rule-suggestion':
      return 'Make the Rule (opens it, filled in, for you to save)';
    case 'bucket-suggestion':
      return 'Add the Bucket (opens it, for you to save)';
    default:
      return 'Accept';
  }
}

// An Item as the card names it: its Source's short name and its title (ENG-418 “Throttle bursts”).
const nameFor = (item: Item) => {
  const label = labelOf(item);
  return `${label ? `${label} ` : ''}“${titleOf(item)}”`;
};

export type LineSkillOptions = Context & {
  // The line a Conversation is about, if it is about one.
  lineOf(conversationId: string): ConversationAboutLine | null;
  now?: () => number;
};

const notDone = (why: string): Findings => ({
  note: `Act on the Update line: Not done: ${why}. Tell the User plainly, in a sentence.`,
  items: [],
  more: [],
});

/**
 * The line Skill (#236): prepares one of the line's own actions as a card under his answer, waiting for
 * the User's Confirm. Only in a Conversation about an Update line, and only what the line offers now.
 */
export function createLineSkill(options: LineSkillOptions): Skill<LineSkillInput, Findings> {
  const now = options.now ?? Date.now;
  return {
    ...LINE_SKILL,
    input: { schema: lineSkillInput, describe: LINE_SKILL_NEEDS },
    async run(input, context: SkillContext = {}) {
      const about = context.conversation ? options.lineOf(context.conversation.conversationId) : null;
      if (!about) throw new SkillInputError('there is no Update line in this Conversation');
      const line = options.itemStore.updates.line(about.queuedId);
      if (line?.status !== 'queued') return notDone(standing(line, now()).replace(/\.$/, ''));
      const offers = lineOffers(line, options);
      let item: Item | null = null;
      if (input.item) {
        const itemId = context.refs?.get(input.item);
        if (!itemId || !line.itemIds.includes(itemId))
          throw new SkillInputError(`${input.item} isn’t one of the line’s Items you were given`);
        item = options.itemStore.get(itemId)?.item ?? null;
        const actions = offers.items.get(itemId) ?? [];
        if (!item || !actions.includes(input.action))
          return notDone(
            `${input.item} doesn’t offer ${input.action} on the line now${actions.length ? ` (it offers ${actions.join(', ')})` : ''}`,
          );
      } else if (input.action !== 'open' && !offers.line.includes(input.action as QueuedAction)) {
        return notDone(
          `the line doesn’t offer ${input.action} on itself now (it offers ${[...offers.line, 'open'].join(', ')})`,
        );
      }
      const snooze = input.action === 'snooze' ? (input.until ?? 'later-today') : null;
      const waiting = waitingOn(line, options.itemStore).length;
      const what = lineActionWhat(line, input.action, { item, snooze, now: now(), waiting });
      const card: ConversationMade = {
        kind: 'line-action',
        updateId: about.updateId,
        queuedId: about.queuedId,
        itemId: item?.id ?? null,
        action: input.action,
        snooze,
        what,
        status: 'waiting',
      };
      const on = input.item ? ` on ${input.item}` : ' on the line';
      return {
        note: `Act on the Update line: Waiting for the User to confirm: ${input.action}${snooze ? ` until ${snooze}` : ''}${on}. It shows under your answer as a card they confirm with one key. It hasn’t happened, so never say it has; tell them plainly, in a sentence, that it waits for them.`,
        items: [],
        more: [],
        made: [card],
      };
    },
  };
}
