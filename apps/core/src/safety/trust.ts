// Whose words an Item holds, judged by where it came from, never by what it says (#22, #69).
// Trusted: the User's own words and settings (Daily Notes and their Blocks, Todos the User added or
// made from a Block). Untrusted: anything that arrived from a Source (an email, someone else's
// issue or comment, an invite), and Todos whose words came from one or from a model: a Linear Todo
// follows its issue's title, a Todo made from an email starts as its subject (#140), and an Ares
// Todo's title was written by a model.
import type { Item } from '@commander/domain';

export type Trust = 'trusted' | 'untrusted';

export function trustOf(item: Item): Trust {
  if (item.source !== null) return 'untrusted';
  if (item.detail?.kind === 'todo') {
    const { origin, backedBy } = item.detail;
    return backedBy === null && (origin === 'manual' || origin === 'daily-note') ? 'trusted' : 'untrusted';
  }
  return item.kind === 'block' || item.kind === 'daily-note' ? 'trusted' : 'untrusted';
}
