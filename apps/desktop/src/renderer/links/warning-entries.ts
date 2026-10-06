import { type ActivityEntry, NOT_AN_INSTRUCTION } from '@commander/domain';

// How an Item's history words Ares's warnings (#69) and refusals (#201), and the User's Not an
// instruction (#186) and its undoing, the same in every Section.

const isNotAnInstruction = (entry: ActivityEntry) =>
  entry.action === 'correction' && entry.by.kind === 'user' && entry.why === NOT_AN_INSTRUCTION;

/** The history line for one of these entries, or null when it is none of them. */
export function describeWarningEntry(entry: ActivityEntry, history: readonly ActivityEntry[]): string | null {
  // Ares says these in his own words: what he ignored, or what he sent to no model.
  if (entry.action === 'injection-warning') return entry.why ?? 'Instructions aimed at Ares, ignored';
  if (entry.action === 'refusal') return entry.why ?? 'Skipped by Ares: it holds a key or sign-in token';
  if (isNotAnInstruction(entry)) return 'Marked not an instruction by you';
  if (entry.action === 'undo') {
    const undone = history.find((other) => other.id === entry.undoes);
    if (undone && isNotAnInstruction(undone)) return 'Not an instruction undone by you: the mark is back';
  }
  return null;
}
