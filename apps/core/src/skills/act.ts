// What every action Skill shares (#196, decisions #24, #11, #22): a Skill that changes something from
// a Conversation only ever proposes. Each change it wants goes to the gate as a proposal, under the
// User's Autonomy settings for its Action kind and Section, with the Conversation as its cause; the
// gate decides whether it is done now (reported in the answer, with Undo) or waits as a suggestion,
// which the Conversation shows as a card the User confirms with one key. A new action Skill (Schedule,
// #198, and settings changes next) builds its proposals and hands them to `acting`:
//
// - Items: the model names them only by the refs handed to him for this answer (I1, I2…); any other
//   ref is refused before anything is proposed.
// - Chaining (ADR 0004, layer 3): when the call that chose the Skill read outside Items (or
//   background), the proposal names the outside Item that caused it (the one it acts on, if that is
//   one, else the first), and is chained unless that was the only outside material and the proposal
//   acts on that Item alone. A chained proposal always asks and shows its cause; the gate checks the
//   same again from the cause. An outside Item carrying the warning mark only ever gets a suggestion.
// - Confidence: the User asked for it in their own words, so it is as sure as Ares gets (1), and Auto
//   when sure goes ahead; Act for you and Delete still never go above Ask.
// - What Ares is told back is Commander's own note, naming Items by their refs and the User's Projects
//   by name, never with words from outside: what was done, what waits for the User, and what wasn't
//   done and why.
import {
  type AutonomySection,
  type ConversationMade,
  type Item,
  type Proposal,
  type RegisteredAction,
  type SkillContext,
  SkillInputError,
} from '@commander/domain';
import { touched } from '../agent/runner';
import { type Gate, GateError } from '../autonomy/gate';
import type { ItemStore } from '../item-store';
import type { Findings } from './findings';

export type ActionSkillOptions = {
  itemStore: ItemStore;
  gate: Pick<Gate, 'propose' | 'registerAction'>;
  now?: () => number;
};

/** One change an action Skill wants, before Commander adds its cause, its reason and the Conversation. */
export type Wanted = {
  // What it does, in Commander's own words for Ares: refs and the User's own names, never outside words.
  what: string;
  proposal: Pick<Proposal, 'actionKind' | 'action' | 'section' | 'itemId' | 'itemActions'>;
};

/** What came of one: done now, waiting for the User, switched off, or refused. */
export type Acted =
  | { what: string; outcome: 'done'; proposalId: number; chained: boolean }
  | { what: string; outcome: 'waiting'; proposalId: number; chained: boolean }
  | { what: string; outcome: 'off' }
  | { what: string; outcome: 'refused'; why: string };

export type Acting = {
  /** The Item a ref names, among those handed out for this answer. */
  item(ref: string): Item;
  /** Hands one change to the gate. */
  propose(wanted: Wanted): Acted;
};

// The longest piece of the User's message an action's reason quotes.
const REASON_QUOTE = 140;

/** The Autonomy Section an Item's own actions belong to. */
export function sectionOfItem(item: Pick<Item, 'kind'>): AutonomySection {
  switch (item.kind) {
    case 'todo':
      return 'todos';
    case 'block':
    case 'daily-note':
      return 'notes';
    case 'email':
      return 'email';
    case 'event':
      return 'calendar';
    case 'linear-issue':
      return 'linear';
    case 'chat':
    case 'channel-post':
      return 'teams';
    default:
      return 'github';
  }
}

/** Registers an action Skill's actions with the gate, so Settings → Autonomy lists them. */
export function registerActions(
  gate: Pick<Gate, 'registerAction'>,
  ...actions: readonly RegisteredAction[]
): void {
  for (const action of actions) gate.registerAction(action);
}

/** Why an action was asked for, for the activity log: the User's words in the Conversation. */
export function reasonFor(asked: string | undefined): string {
  const words = asked?.replace(/\s+/g, ' ').trim() ?? '';
  if (!words) return 'You asked for this in a Conversation.';
  const quoted = words.length > REASON_QUOTE ? `${words.slice(0, REASON_QUOTE - 1).trimEnd()}…` : words;
  return `You asked in a Conversation: “${quoted}”`;
}

/**
 * The cause a proposal names, and whether it is chained, from what the call that chose the Skill
 * read (ADR 0004): nothing from outside, no cause; otherwise the outside Item it acts on (else the
 * first one read), chained unless that was all the outside material and it acts on that Item alone.
 */
export function causeOf(
  proposal: Pick<Proposal, 'itemId' | 'itemActions'>,
  read: SkillContext['read'],
): Pick<Proposal, 'causedBy' | 'chained'> {
  const outside = [...new Set(read?.outside ?? [])];
  const background = read?.background ?? null;
  if (!outside.length && !background) return { chained: false };
  if (!outside.length) {
    const first = background?.[0];
    return { ...(first && { causedBy: { itemId: first } }), chained: true };
  }
  const cause = outside.includes(proposal.itemId) ? proposal.itemId : (outside[0] as string);
  const onItself = outside.length === 1 && !background && cause === proposal.itemId;
  const alone = [...touched(proposal)].every((itemId) => itemId === proposal.itemId);
  return { causedBy: { itemId: cause }, chained: !(onItself && alone) };
}

/**
 * The Item a ref names, among those handed out for this answer (any Skill run in a Conversation,
 * #198): any other ref, or an Item gone since, is refused before anything runs.
 */
export function handedItem(context: SkillContext, itemStore: Pick<ItemStore, 'get'>, ref: string): Item {
  const itemId = context.refs?.get(ref.trim());
  const item = itemId ? itemStore.get(itemId)?.item : undefined;
  if (!item || item.deletedAt !== null) {
    throw new SkillInputError(`${ref} isn’t one of the Items you were given for this message`);
  }
  return item;
}

/** An action Skill's way to its Items and the gate, for one run in a Conversation. */
export function acting(context: SkillContext, { itemStore, gate }: ActionSkillOptions): Acting {
  const reason = reasonFor(context.asked);
  // An outside Item carrying the warning mark only ever gets a suggestion (ADR 0004, third amendment).
  const marked = (itemIds: Iterable<string>) =>
    [...itemIds].some((itemId) => itemStore.injectionWarnings.warning(itemId) !== null);
  return {
    item: (ref) => handedItem(context, itemStore, ref),

    propose({ what, proposal }) {
      const cause = causeOf(proposal, context.read);
      const askOnly = marked([...(context.read?.outside ?? []), ...touched(proposal)]);
      try {
        const outcome = gate.propose(
          {
            ...proposal,
            confidence: 1,
            reason,
            ...cause,
            ...(context.conversation && { conversation: context.conversation }),
          },
          { askOnly },
        );
        if (outcome.decision === 'off') return { what, outcome: 'off' };
        if (outcome.decision === 'auto') {
          return { what, outcome: 'done', proposalId: outcome.done.id, chained: outcome.done.chained };
        }
        return {
          what,
          outcome: 'waiting',
          proposalId: outcome.suggestion.id,
          chained: outcome.suggestion.chained,
        };
      } catch (error) {
        if (!(error instanceof GateError)) throw error;
        return { what, outcome: 'refused', why: error.message };
      }
    },
  };
}

/**
 * What an action Skill hands the Conversation: Commander's note on what came of each change (and what
 * it didn't try, `skipped`, with why), and the proposals, which show under the answer as cards.
 * `also`: more of Commander's own lines for him (other free times, #198), and what the Skill made for
 * the answer to show (a reply with the booking link).
 */
export function actionFindings(
  title: string,
  acted: readonly Acted[],
  skipped: readonly string[] = [],
  also: { lines?: readonly string[]; made?: ConversationMade[] } = {},
): Findings {
  const lines = acted.map((each): string => {
    if (each.outcome === 'done') return `Done: ${each.what}. It shows under your answer, with Undo.`;
    if (each.outcome === 'waiting') {
      return `Waiting for the User to confirm: ${each.what}. It shows under your answer as a card they confirm with one key. It hasn’t happened, so never say it has.${each.chained ? ' It asks first because it follows from what your Skills found, not only from the User’s words.' : ''}`;
    }
    if (each.outcome === 'off')
      return `Not done: ${each.what}. The User’s Autonomy settings have this switched off (Settings → Autonomy).`;
    return `Not done: ${each.what}. ${each.why.replace(/[.\s]+$/, '')}.`;
  });
  lines.push(...skipped.map((why) => `Not done: ${why}.`));
  lines.push(...(also.lines ?? []));
  if (!lines.length) lines.push('Nothing to do: none of it needed changing.');
  return {
    note: `${title}: ${lines.join(' ')} Tell the User plainly, in a sentence or two, what was done and what waits for them, naming Items by their refs; don’t use ${title} again for the same thing.`,
    items: [],
    more: [],
    proposalIds: acted.flatMap((each) => ('proposalId' in each ? [each.proposalId] : [])),
    ...(also.made?.length && { made: also.made }),
  };
}
