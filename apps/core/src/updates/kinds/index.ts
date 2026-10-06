// Every kind of Update line (#186), in one registry: its plain sentence, the facts Ares is handed for
// it, how each of its Items stands, and what the prompt says a good line of that kind is. A producer
// adding a kind of line adds its entry here (the registry's type asks for every kind).
import type { QueuedAbout, QueuedKind, QueuedLine, UpdateRow } from '@commander/domain';
import { capLines, prepLines, summaryLines } from './ares';
import { leftLines, reconnectLines, stuckLines } from './linear';
import { autonomyLines, chainedLines, ruleLines, suggestionLines } from './suggestions';
import { chatLines } from './teams';
import type { LineContext, LineKind, LineKinds, RowFacts } from './types';
import { warningLines } from './warnings';
import { labelOf, sectionOf, titleOf } from './words';

export type { LineContext, RowFacts } from './types';
export { labelOf, nameOf, SECTION_OF_KIND, sectionOf, sourceOf, titleOf, whereOf } from './words';

export const LINE_KINDS: LineKinds = {
  suggestions: suggestionLines,
  chained: chainedLines,
  'injection-warnings': warningLines,
  'cap-warning': capLines,
  'autonomy-change': autonomyLines,
  'linear-left': leftLines,
  'linear-stuck': stuckLines,
  reconnect: reconnectLines,
  'meeting-prep': prepLines,
  'chat-summary': chatLines,
  'github-summary': summaryLines,
  'rule-suggestion': ruleLines,
};

type Line = Pick<QueuedLine, 'about' | 'itemIds'>;

const kindOf = (about: QueuedAbout) => LINE_KINDS[about.kind] as unknown as LineKind<QueuedKind>;

/** The line's plain sentence: what it is, what happened, why it matters and what to do. */
export const lineTemplate = (line: Line, context: LineContext) => kindOf(line.about).template(line, context);

/** What Commander knows of the line, in its own words, for its data block. */
export const lineFacts = (line: Line, context: LineContext) => kindOf(line.about).facts(line, context);

/** What the line is about, in a few words. */
export const kindName = (about: QueuedAbout) => kindOf(about).name;

/** Lines worded elsewhere, or kept in Commander's own words: not sent to the model. */
export const isApart = (about: QueuedAbout) => kindOf(about).apart === true;

/** How one Item of a line stands; null when it is no longer one of the line's. */
export const rowFacts = (line: Line, itemId: string, context: LineContext): RowFacts | null =>
  kindOf(line.about).row(line, itemId, context);

/**
 * The line's Items, as the Update lists them: `itemIds` are the ones the Update was given about, in
 * its order. `waiting` is false once the line has been dealt with: then each only opens.
 */
export function lineRows(
  line: Line,
  itemIds: readonly string[],
  context: LineContext,
  { waiting = true }: { waiting?: boolean } = {},
): UpdateRow[] {
  return itemIds.flatMap((itemId) => {
    const item = context.item(itemId);
    if (!item) return [];
    const facts = rowFacts(line, itemId, context) ?? {
      state: 'Dealt with',
      actions: ['open' as const],
      settled: 'Dealt with',
    };
    return [
      {
        itemId,
        label: labelOf(item),
        title: titleOf(item),
        section: sectionOf(item),
        state: item.deletedAt !== null ? 'Gone from its Source' : facts.state,
        quote: facts.quote ?? null,
        focus: facts.focus ?? null,
        actions: waiting && item.deletedAt === null ? facts.actions : ['open'],
        settled: facts.settled ?? null,
      },
    ];
  });
}

/** The line without one of its Items (dismissed from the Update), or null when none would be left. */
export function lineWithout(line: Line, itemId: string, context: LineContext): Line | null {
  const itemIds = line.itemIds.filter((each) => each !== itemId);
  const without = kindOf(line.about).without;
  const about = without ? without(line.about, itemId, context) : null;
  return about && itemIds.length ? { about, itemIds } : null;
}

/** The prompt's guidance for these kinds of line, once each, in the registry's order. */
export function guidanceFor(kinds: Iterable<QueuedKind>): string {
  const wanted = new Set(kinds);
  return (Object.keys(LINE_KINDS) as QueuedKind[])
    .filter((kind) => wanted.has(kind) && LINE_KINDS[kind].guidance)
    .map((kind) => LINE_KINDS[kind].guidance)
    .join('\n\n');
}
