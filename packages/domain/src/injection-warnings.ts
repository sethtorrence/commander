import type { ItemKind } from './items';

// The warning mark (#69): an outside Item holding instructions aimed at Ares says so wherever it is
// shown, and the same words go in its injection-warning activity entry. There is no pop-up.

const NOUNS: Partial<Record<ItemKind, string>> = {
  email: 'email',
  event: 'invite',
  'linear-issue': 'issue',
  'pull-request': 'pull request',
  'review-request': 'review request',
  'github-issue': 'issue',
  'github-release': 'release',
  chat: 'chat',
  'channel-post': 'post',
  // A Todo shows the mark of the Item behind it: a Linear issue, today.
  todo: 'Todo’s issue',
};

/** "This issue contains instructions aimed at Ares. He ignored them." */
export function injectionWarningText(kind: ItemKind): string {
  return `This ${NOUNS[kind] ?? 'item'} contains instructions aimed at Ares. He ignored them.`;
}
