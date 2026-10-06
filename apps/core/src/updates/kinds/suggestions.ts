// Update lines about Ares's suggestions (#70, #71, #186): ones he wasn't sure about, ones made because
// of someone else's words (chained), "want me to just do them?", and Rule suggestions. Each says what
// he suggests and on which Item, that nothing happens until the User says, and how to say it.
import {
  type AutonomyLevel,
  chatReply,
  MESSAGE_FIELD,
  type ProposalRecord,
  ruleSuggestionText,
} from '@commander/domain';
import type { LineContext, LineKind, RowFacts } from './types';
import { cut, listed, namedWhere, nameOf, plural } from './words';

const KIND_NAMES: Record<string, string> = { todo: 'Todo', block: 'Block', event: 'event' };
const ANSWERS: Record<string, string> = {
  accepted: 'accepting the invitation',
  tentative: 'answering Maybe to the invitation',
  declined: 'declining the invitation',
};

/** What a suggestion would do, in a few words: "adding the Todo “Send Dana the Q3 numbers”". */
export function suggests(record: ProposalRecord | null, context: LineContext): string | null {
  for (const step of record?.itemActions ?? []) {
    switch (step.type) {
      case 'create':
        return `adding the ${KIND_NAMES[step.item.kind] ?? step.item.kind} “${cut(step.item.title, 80)}”`;
      case 'update': {
        const { filing, status, title } = step.changes;
        if (filing) return `filing it under ${context.projectCode(filing.projectId) ?? 'a Project'}`;
        if (filing === null) return 'unfiling it';
        if (status) return `marking it ${status}`;
        if (title !== undefined) return `renaming it “${cut(title, 80)}”`;
        break;
      }
      case 'edit-fields': {
        const reply = Object.entries(step.fields).find(([field]) => field.startsWith(MESSAGE_FIELD))?.[1];
        if (chatReply.safeParse(reply).success) return 'sending a reply in Teams';
        const answer = ANSWERS[String(step.fields.response)];
        if (answer) return answer;
        break;
      }
      case 'create-event': {
        const { kind, title } = step.event;
        if (kind === 'focus-block') return `putting a focus block, “${cut(title, 80)}”, in your calendar`;
        if (kind === 'meeting') return `putting “${cut(title, 80)}” in your calendar`;
        return 'putting a Busy copy on your other calendar';
      }
      case 'delete':
        return 'deleting it';
    }
  }
  return null;
}

const SETTLED: Record<ProposalRecord['status'], string | null> = {
  pending: null,
  accepted: 'Accepted',
  dismissed: 'Dismissed',
  done: 'Done',
};

// A suggestion's row: what it would do, with Accept and Dismiss while it waits.
function suggestionRow(
  records: readonly ProposalRecord[],
  itemId: string,
  action: string,
  context: LineContext,
): RowFacts | null {
  const pending = records.filter((record) => record.itemId === itemId && record.status === 'pending');
  const [first] = pending;
  if (first) {
    const what = suggests(first, context);
    return {
      state: what ? `Suggests ${what}` : 'A suggestion waiting for you',
      actions: ['open', 'accept', 'dismiss'],
      more: [`Ares's reason: ${cut(first.reason, 300)}`],
    };
  }
  const settled = context.proposalsOn(itemId).find((record) => record.action === action);
  const word = settled ? SETTLED[settled.status] : null;
  return word ? { state: word, actions: ['open'], settled: word } : null;
}

const records = (ids: readonly number[], context: LineContext) =>
  ids.map((id) => context.proposal(id)).filter((record): record is ProposalRecord => record !== null);

export const suggestionLines: LineKind<'suggestions'> = {
  name: 'suggestions Ares wasn’t sure about',
  template({ about, itemIds }, context) {
    const count = about.proposalIds.length;
    if (count === 1) {
      const [record] = records(about.proposalIds, context);
      const what = suggests(record ?? null, context) ?? 'one suggestion';
      const item = context.item(record?.itemId ?? itemIds[0] ?? '');
      return `${about.name}: I wasn’t sure about ${what}${item ? `, on ${namedWhere(item)}` : ''}. Nothing happens unless you accept it; dismiss it if it’s wrong.`;
    }
    const names = itemIds.flatMap((itemId) => {
      const item = context.item(itemId);
      return item ? [nameOf(item)] : [];
    });
    return `${about.name}: ${count} suggestions I wasn’t sure about${names.length ? `, on ${listed(names)}` : ''}. Nothing happens unless you accept them; each is below.`;
  },
  facts: ({ about }) => [
    `Ares's action: ${about.name}`,
    `How many suggestions: ${about.proposalIds.length}`,
    'Each waits on its Item for the User to accept or dismiss it; nothing happens until then.',
  ],
  row: ({ about }, itemId, context) =>
    suggestionRow(records(about.proposalIds, context), itemId, about.action, context),
  without(about, itemId, context) {
    const left = records(about.proposalIds, context).filter((record) => record.itemId !== itemId);
    return left.length ? { ...about, proposalIds: left.map((record) => record.id) } : null;
  },
  guidance: `Suggestions you weren't sure about: say what you suggest and on which Item, that nothing happens unless the User accepts, and that they can accept or dismiss it. For several, say how many and name up to three.
Good: "Suggest Todos: I wasn’t sure about adding the Todo “Send Dana the Q3 numbers”, from your note “need to send Dana the Q3 numbers”. Nothing happens unless you accept it."
Bad: "One suggestion I wasn’t sure about is waiting for you." (Which one? What would it do?)`,
};

export const chainedLines: LineKind<'chained'> = {
  name: 'a suggestion made because of someone else’s words',
  template({ about, itemIds }, context) {
    const record = context.proposal(about.proposalId);
    const what = suggests(record, context) ?? 'a change';
    const on = context.item(itemIds[0] ?? '');
    const cause = context.item(itemIds[1] ?? '');
    return `${about.name}: ${cause ? namedWhere(cause) : 'something from outside'} led me to suggest ${what}${on ? `, on ${namedWhere(on)}` : ''}. It came from someone else’s words, so it waits for you: accept it only if it looks right.`;
  },
  facts: ({ about }) => [
    `Ares's action: ${about.name}`,
    'What it is: one suggestion Ares made because of another Item (someone else’s words), so it always waits for the User, however sure he is.',
    'The first Item block is the Item it is on; the second, when there is one, is what led to it.',
  ],
  row({ about, itemIds }, itemId, context) {
    if (itemId !== itemIds[0]) return { state: 'What led to it', actions: ['open'] };
    const record = context.proposal(about.proposalId);
    return suggestionRow(record ? [record] : [], itemId, about.action, context);
  },
  // One suggestion: dismissing its Item is dismissing the line.
  without: () => null,
  guidance: `A suggestion made because of someone else's words (chained): say what led to it, what you suggest and on which Item, and that because it came from someone else it waits for the User's say-so.
Good: "The email “Notes from the vendor call” led me to suggest a Todo, “Reply to the vendor”. It came from someone else’s words, so it waits for you."
Bad: "Something from outside led me to a suggestion." (What, from where, about what?)`,
};

const LEVEL_WORDS: Record<AutonomyLevel, string> = {
  off: 'stop doing them',
  ask: 'suggest them for you to accept',
  'auto-when-sure': 'do them myself when I’m sure',
  auto: 'do them myself',
};
const LEVEL_NAMES: Record<AutonomyLevel, string> = {
  off: 'Off',
  ask: 'Ask',
  'auto-when-sure': 'Auto when sure',
  auto: 'Auto',
};

export const autonomyLines: LineKind<'autonomy-change'> = {
  name: 'whether Ares may just do something himself',
  template: ({ about }) =>
    `You’ve accepted my last ${about.accepted} ${about.name} suggestions without changing any. Say yes and I’ll ${LEVEL_WORDS[about.to]}, instead of asking each time; dismiss this to keep asking.`,
  facts: ({ about }) => [
    `Ares's action: ${about.name}`,
    `Suggestions the User accepted in a row without changing any: ${about.accepted}`,
    `Now: ${LEVEL_NAMES[about.from]} (Ares ${LEVEL_WORDS[about.from].replace('I’m', 'he’s')})`,
    `If the User says yes: ${LEVEL_NAMES[about.to]} (Ares will ${LEVEL_WORDS[about.to].replace('I’m', 'he’s')})`,
    'Saying yes is this line’s Accept; dismissing it keeps things as they are.',
  ],
  row: () => null,
  guidance: `Whether you may just do something yourself: say what the User did (accepted the last suggestions without changes), what would change if they say yes, and that dismissing keeps things as they are.
Good: "You’ve accepted my last 20 Suggest Todos suggestions as they were. Say yes and I’ll make them myself when I’m sure."
Bad: "Want me to be more autonomous?" (Jargon, and it doesn't say what would change.)`,
};

export const ruleLines: LineKind<'rule-suggestion'> = {
  name: 'a Rule Ares suggests',
  template: ({ about }) =>
    `${ruleSuggestionText(about)} A Rule would do it for you from now on: make the Rule, or dismiss this and I won’t ask again.`,
  facts: ({ about }) => [
    `What the User did: ${ruleSuggestionText(about).split('. ')[0]}.`,
    `The Rule: ${ruleSuggestionText(about).split('. ').slice(1).join('. ')}`,
    `How many the User filed that way: ${plural(about.count, 'Item')}`,
    'Accepting opens the Rule, filled in, for the User to save; dismissing stops Ares asking again.',
  ],
  row: () => null,
  guidance: `A Rule you suggest: say what the User kept doing, the Rule that would do it for them, and that they can make it or dismiss it.
Good: "You’ve filed 5 Linear issues from team OPS under TX. A Rule could do that for you: make it, or dismiss this and I won’t ask again."
Bad: "I noticed a pattern in your filing." (What pattern? What would happen?)`,
};
