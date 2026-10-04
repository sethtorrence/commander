// Ares's GitHub summary in the Update (#121), found whenever the producers look (after every sync,
// whenever the gate acts, each time a summary is written or opened, and every minute).
//
// - The latest daily summary or Monday roll-up the User hasn't opened is one For your information
//   line: its first lines, in Ares's words, with Open (which opens it in the GitHub Section).
// - Once the User opens it (on the Dashboard, in the Update or the GitHub Section), or a newer one is
//   written, its line goes (resolved). A summary's line is queued once: dealt with, it never comes back.
import { isGitHubSummary, type QueuedLine, queuedStatuses, summaryLead } from '@commander/domain';
import type { ItemStore } from '../item-store';
import type { UpdateQueue } from './queue';

export const githubSummaryKey = (itemId: string) => `github-summary:${itemId}`;
const IMPORTANCE = 0.4;
const ON_FIRE_IMPORTANCE = 0.8;
const MAX_LEAD = 600;

type SummaryLine = QueuedLine & { about: Extract<QueuedLine['about'], { kind: 'github-summary' }> };
const isSummaryLine = (line: QueuedLine): line is SummaryLine => line.about.kind === 'github-summary';

export function createGitHubSummaryWatch({ itemStore, queue }: { itemStore: ItemStore; queue: UpdateQueue }) {
  const store = itemStore.updates;

  function sweep() {
    const [latest] = itemStore.githubSummaries.list({ cadences: ['daily', 'weekly'], limit: 1 });
    const wanted = isGitHubSummary(latest) && latest.detail.seenAt === null ? latest : null;

    // Lines queued already: an opened, deleted or older summary's leaves.
    for (const line of store.lines(['queued']).filter(isSummaryLine)) {
      if (line.about.summaryId !== wanted?.id) queue.resolve(line.id);
    }
    if (!wanted) return;
    const key = githubSummaryKey(wanted.id);
    if (store.lines([...queuedStatuses]).some((line) => line.mergeKey === key)) return;
    const lead = summaryLead(wanted.detail);
    queue.enqueue({
      group: 'fyi',
      mergeKey: key,
      about: {
        kind: 'github-summary',
        summaryId: wanted.id,
        label: wanted.title,
        lead: lead.length > MAX_LEAD ? `${lead.slice(0, MAX_LEAD - 1).trimEnd()}…` : lead,
        onFire: wanted.detail.onFire.length > 0,
      },
      itemIds: [wanted.id],
      section: 'github',
      importance: wanted.detail.onFire.length ? ON_FIRE_IMPORTANCE : IMPORTANCE,
    });
  }

  return { sweep };
}
