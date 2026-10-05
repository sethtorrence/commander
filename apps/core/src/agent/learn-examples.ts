// Examples (#74): what the User's answers to Ares teach him, learned into Memory as example memories.
// Code, not a model: the answers are already in the activity log and the gate's record, so Ares
// follows them from where he got to (and from the start, the first time, so answers given before
// Memory existed count too).
//
// - Each correction and confirmation of his filing (filing-feedback.ts): "Linear issue OPS-1 (team
//   OPS · Relay · infra) belongs to TX (Tactics), not TL (Titanlink)". About the Project chosen and the
//   Item's people, found by the Item's words, with the Item as its source.
// - Each "Suggest Todos" suggestion on a Block the User dismissed, and each Todo of his from one the
//   User undid: "Not a Todo: “dentist was fine” (Ares suggested “Book the dentist”)", with the Block as
//   its source.
//
// They are the User's own answers, so they are confirmed. Each is learned once (keyed by its activity
// entry or proposal), and one the User deletes is never learned again.
import type { Item, ProposalRecord } from '@commander/domain';
import type { ItemStore } from '../item-store';
import { aboutItem } from './memory-context';
import { SUGGEST_TODOS } from './suggest-todos';

const FILING_PROGRESS = 'examples:filing';
// The Todo suggestions looked at each time, newest first: dismissing or undoing one comes soon after.
const TODO_SUGGESTIONS = 300;

const cut = (text: string, length: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > length ? `${one.slice(0, length - 1).trimEnd()}…` : one;
};

const blockText = (item: Item) => (item.detail?.kind === 'block' ? item.detail.text : item.title);

// The Todo a "Suggest Todos" proposal would make.
function todoTitle(proposal: ProposalRecord): string | null {
  const step = proposal.itemActions[0];
  return step?.type === 'create' && step.item.kind === 'todo' ? step.item.title : null;
}

/** Learns the examples the User's answers since last time teach. Returns how many were learned. */
export function learnExamples(itemStore: ItemStore): number {
  let learned = 0;
  const named = (projectId: string | null) => {
    if (!projectId) return 'no Project';
    const project = itemStore.projectRef(projectId);
    return project ? `${project.code} (${project.title})` : 'a Project since deleted';
  };

  // Corrections and confirmations of his filing, oldest first.
  const after = itemStore.memory.progress(FILING_PROGRESS) ?? 0;
  const answers = itemStore.filing
    .feedback()
    .filter((answer) => answer.entryId > after)
    .reverse();
  const learnedBefore = itemStore.memory.knows(answers.map((answer) => `filing:${answer.entryId}`));
  for (const answer of answers) {
    const item = itemStore.get(answer.itemId)?.item;
    if (item && !learnedBefore.has(`filing:${answer.entryId}`)) {
      const about = aboutItem(item);
      const text =
        answer.kind === 'confirmation'
          ? `${about.subject} belongs to ${named(answer.chosen)}`
          : `${about.subject} belongs to ${named(answer.chosen)}, not ${named(answer.suggested)}`;
      const memory = itemStore.memory.learn({
        kind: 'example',
        key: `filing:${answer.entryId}`,
        text,
        keywords: about.words,
        confirmed: true,
        projectId: answer.chosen,
        handles: about.handles,
        sources: [item.id],
      });
      if (memory) learned++;
    }
    itemStore.memory.saveProgress(FILING_PROGRESS, answer.entryId);
  }

  // Todo suggestions on Blocks the User dismissed, or whose Todo they undid.
  const recent = itemStore.autonomy.proposals({
    action: SUGGEST_TODOS,
    statuses: ['dismissed', 'done', 'accepted'],
    limit: TODO_SUGGESTIONS,
  });
  const keyOf = (proposal: ProposalRecord) =>
    `todo-${proposal.status === 'dismissed' ? 'dismissed' : 'undone'}:${proposal.id}`;
  const known = itemStore.memory.knows(recent.map(keyOf));
  const undone = new Set(itemStore.undone(recent.flatMap((proposal) => proposal.entryIds)));
  for (const proposal of recent) {
    if (known.has(keyOf(proposal))) continue;
    const dismissed = proposal.status === 'dismissed';
    if (!dismissed && !proposal.entryIds.some((entryId) => undone.has(entryId))) continue;
    const block = itemStore.get(proposal.itemId)?.item;
    const title = todoTitle(proposal);
    if (block?.kind !== 'block' || !title) continue;
    const said = cut(blockText(block), 160);
    const memory = itemStore.memory.learn({
      kind: 'example',
      key: keyOf(proposal),
      text: dismissed
        ? `Not a Todo: “${said}” (Ares suggested “${title}”)`
        : `Not a Todo: “${said}” (Ares added “${title}”, and the User undid it)`,
      keywords: title,
      confirmed: true,
      projectId: block.filing?.projectId ?? null,
      sources: [block.id],
    });
    if (memory) learned++;
  }
  return learned;
}
