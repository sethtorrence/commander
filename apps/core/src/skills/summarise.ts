// Summarise, on what a Conversation names (#192): Ares works out what the User means and gathers what
// Commander holds about it, read, for the Conversation's answer to sum up. (Summarise on a Chat from
// the Teams Section is the job in ../agent/summarise-chat.ts, unchanged.)
//
// What the words can name, tried in this order:
// - an Item he was shown in this answer, by its ref, which the Conversation turns into `item:<id>`;
// - a Project, by its code or its name: its Items over the range (a week unless the User says);
// - a GitHub repo, as owner/name or its name alone: its pull requests, issues and releases;
// - a thread: the email thread or Teams Chat (or post) search finds best for the words. An email
//   thread is each of its messages (all of it unless the User says), a Chat its messages in range.
// "This sprint" is the Linear cycle under way among the Items, else the last fourteen days. Nothing
// matching is said so plainly, never guessed at. The same limits as Find: no Gmail mail before the
// User allowed it, no tombstones, none of Ares's own Items, and at most a couple of dozen Items.
import {
  type Item,
  isSpoken,
  mayReadMail,
  type Project,
  type SummariseTarget,
  type SummaryTargetRange,
} from '@commander/domain';
import type { ItemStore } from '../item-store';
import { meaningfulWords, projectNamed } from './find';
import { type Findings, findable, type Range, summaryRangeOf, timeOf } from './findings';
import { readItem } from './read-item';

// The most Items one summary reads.
export const SUMMARY_LIMIT = 25;
const THREAD_LIMIT = 15;

export type SummariseOptions = {
  itemStore: ItemStore;
  now?: () => number;
};

const GITHUB_KINDS = ['pull-request', 'github-issue', 'github-release'] as const;

const repoOf = (item: Item) =>
  item.detail?.kind === 'pull-request' ||
  item.detail?.kind === 'github-issue' ||
  item.detail?.kind === 'github-release'
    ? `${item.detail.repo.owner}/${item.detail.repo.name}`
    : null;

/** Gathers what Commander holds about the target the User named, for a Conversation to summarise. */
export function createSummariseTarget(options: SummariseOptions) {
  const { itemStore } = options;
  const now = options.now ?? Date.now;
  const mayRead = (item: Item) => mayReadMail(itemStore.models.settings(), item.source, item.account);
  const projectCode = (projectId: string) =>
    itemStore.projects({ includeArchived: true }).find((project) => project.id === projectId)?.code ?? null;
  const emailText = (itemId: string) => itemStore.emailBody(itemId)?.text ?? null;
  const read = (items: readonly Item[]) =>
    items.map((item) => ({ item, text: readItem(item, { emailText, projectCode }) }));

  // The start of the Linear cycle under way among these Items, if one is.
  function cycleStart(items: readonly Item[]): number | null {
    const at = now();
    for (const item of items) {
      const cycle = item.detail?.kind === 'linear-issue' ? item.detail.cycle : null;
      if (cycle && cycle.startsAt <= at && at < cycle.endsAt) return cycle.startsAt;
    }
    return null;
  }

  const newestFirst = (items: Item[]) => items.sort((a, b) => timeOf(b) - timeOf(a));
  const within = (range: Range) => (item: Item) => timeOf(item) >= range.from && timeOf(item) < range.to;

  function over(range: SummaryTargetRange | undefined, fallback: SummaryTargetRange, items: readonly Item[]) {
    return summaryRangeOf(range ?? fallback, now(), cycleStart(items));
  }

  function project(found: Project, range: SummaryTargetRange | undefined): Findings {
    const all = itemStore
      .query({ projectId: found.id, limit: 1000 })
      .filter((item) => findable(item, mayRead));
    const span = over(range, 'week', all);
    const items = newestFirst(all.filter(within(span)));
    return {
      note: `Summarise gathered what is filed under the Project ${found.name} (${found.code}) over ${span.words}: ${counted(items.length)}.`,
      items: read(items.slice(0, SUMMARY_LIMIT)),
      more: [],
    };
  }

  function repo(name: string, range: SummaryTargetRange | undefined): Findings {
    const all = itemStore
      .query({ kinds: [...GITHUB_KINDS], limit: 1000 })
      .filter((item) => findable(item, mayRead) && repoOf(item)?.toLowerCase() === name.toLowerCase());
    const span = over(range, 'week', all);
    const items = newestFirst(all.filter(within(span)));
    return {
      note: `Summarise gathered the pull requests, issues and releases of the GitHub repo ${name} over ${span.words}: ${counted(items.length)}.`,
      items: read(items.slice(0, SUMMARY_LIMIT)),
      more: [],
    };
  }

  // An email thread (each message), a Chat (its messages in range) or anything else on its own.
  function thread(item: Item, range: SummaryTargetRange | undefined): Findings {
    const detail = item.detail;
    if (detail?.kind === 'email' && item.account) {
      const messages = (itemStore.emailThread(item.account, detail.threadKey)?.messages ?? [])
        .map((message) => message.item)
        .filter((message) => findable(message, mayRead));
      const span = over(range, 'all', messages);
      const items = messages.filter(within(span)).sort((a, b) => timeOf(a) - timeOf(b));
      const shown = items.slice(-THREAD_LIMIT);
      return {
        note: `Summarise gathered an email thread over ${span.words}: ${counted(items.length, 'message')}${shown.length < items.length ? `, the latest ${shown.length} read here` : ''}, oldest first.`,
        items: read(shown),
        more: [],
      };
    }
    if (detail?.kind === 'chat') {
      const span = over(range, 'week', [item]);
      const messages = detail.messages.filter(
        (message) => isSpoken(message) && message.createdAt >= span.from && message.createdAt < span.to,
      );
      const chat: Item = { ...item, detail: { ...detail, messages } };
      return {
        note: `Summarise gathered a Teams Chat over ${span.words}: ${counted(messages.length, 'message')}.`,
        items: messages.length ? read([chat]) : [],
        more: [],
      };
    }
    return { note: 'Summarise gathered one Item, read here.', items: read([item]), more: [] };
  }

  return async function summariseTarget({ target, range }: SummariseTarget): Promise<Findings> {
    if (target.startsWith('item:')) {
      const item = itemStore.get(target.slice('item:'.length))?.item;
      if (item && findable(item, mayRead)) return thread(item, range);
      return { note: 'Summarise couldn’t find that Item in Commander any more.', items: [], more: [] };
    }
    const named = projectNamed(itemStore.projects(), target);
    if (named) return project(named, range);
    const repos = new Set(
      itemStore
        .query({ kinds: [...GITHUB_KINDS], limit: 1000 })
        .flatMap((item) => (repoOf(item) ? [repoOf(item) as string] : [])),
    );
    const wanted = target.trim().toLowerCase();
    const repoName =
      [...repos].find((name) => name.toLowerCase() === wanted) ??
      [...repos].find((name) => name.toLowerCase().split('/')[1] === wanted);
    if (repoName) return repo(repoName, range);
    const words = meaningfulWords(target);
    if (words.length) {
      const hits = itemStore.search.query({
        text: `${words.join(' ')} `,
        kinds: ['email', 'chat', 'channel-post'],
        limit: 20,
      }).hits;
      const best = hits.map((hit) => hit.item).find((item) => findable(item, mayRead));
      if (best) return thread(best, range);
    }
    return {
      note: `Summarise found nothing in Commander matching “${target}”: no Project, GitHub repo, email thread or Chat by that name.`,
      items: [],
      more: [],
    };
  };
}

const counted = (n: number, what = 'Item') => `${n} ${what}${n === 1 ? '' : 's'}`;
