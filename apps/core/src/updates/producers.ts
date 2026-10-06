// What goes in Ares's queue, found by looking at what has happened since the producers last looked
// (cursors kept in the database, so nothing is missed or queued twice across restarts):
//
// - Suggestions Ares wasn't sure about (Ask suggestions the gate kept), merged into one line per
//   action, waiting on the User's decision. A chained suggestion (made because of another Item)
//   gets a line of its own, naming its cause. A suggestion settled elsewhere (on the activity page,
//   in a Daily Note's margin) leaves its line, and a line with none left is resolved.
// - Injection warnings: outside Items that held instructions aimed at Ares, counted in one line.
// - The month's 80% cost-cap warning, once a month, expiring when the month does.
// - Autonomy changes: once the User has accepted the last 20 suggestions of one action without
//   changing any (none dismissed or undone), "Want me to just do them?". Only if the action's next
//   level is within its hard limit; the next offer for that action counts only suggestions after it.
//
// - Linear (linear.ts): issues taken off the User's list, stuck issues that changed, and Accounts
//   needing reconnecting.
// - Teams (teams.ts): busy Chats, summarised when the Update is put together.
// - Rule suggestions (rule-suggestions.ts): "Always file Linear team OPS under TX?", once the User's
//   answers to Ares's filing point one Source field value at one Project often enough.
// - Bucket Rule suggestions (bucket-rule-suggestions.ts): "Always put mail from stripe.com in
//   Receipts?", once the User's answers to Ares's sorting point one sender at one Bucket often enough.
// - GitHub (github.ts): Ares's latest unseen GitHub summary, daily or the Monday roll-up (#121).
//
// Later producers (meeting prep, the GitHub summary, missed send-later) call the queue's `enqueue`
// themselves, as the "Spot stuck Linear issues" job does.
import {
  type ActivityEntry,
  autonomyLevels,
  chosenLevel,
  HARD_LIMITS,
  type ItemKind,
  isAllowed,
  type ProposalRecord,
  type UpdateSection,
} from '@commander/domain';
import type { Gate } from '../autonomy/gate';
import type { ItemStore } from '../item-store';
import { createBucketRuleSuggestions } from './bucket-rule-suggestions';
import { createGitHubSummaryWatch } from './github';
import { createLinearWatch, type WatchedAccount } from './linear';
import type { UpdateQueue } from './queue';
import { createRuleSuggestions } from './rule-suggestions';
import { createTeamsWatch } from './teams';

// How many accepted suggestions in a row make Ares ask to just do them.
export const STREAK = 20;

const SECTION_OF_KIND: Partial<Record<ItemKind, UpdateSection>> = {
  'linear-issue': 'linear',
  email: 'email',
  event: 'calendar',
  'pull-request': 'github',
  'review-request': 'github',
  'github-issue': 'github',
  'github-release': 'github',
  chat: 'teams',
  'channel-post': 'teams',
  todo: 'todos',
  block: 'notes',
  'daily-note': 'notes',
};

const IMPORTANCE = {
  chained: 0.8,
  suggestions: 0.6,
  autonomy: 0.5,
  warnings: 0.7,
  cap: 0.6,
} as const;

// The first day of the next month, in the User's local time.
const nextMonth = (at: number) => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
};
const monthKey = (at: number) => {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

export function createProducers({
  itemStore,
  gate,
  queue,
  now,
  accounts,
  me,
}: {
  itemStore: ItemStore;
  gate: Pick<Gate, 'actions' | 'settings'>;
  queue: UpdateQueue;
  now: () => number;
  // Every Account, for Reconnect.
  accounts?: () => readonly WatchedAccount[];
  // Who the User is in a Teams Account, for counting a busy Chat's messages from others.
  me?: (account: string) => string | null;
}) {
  const store = itemStore.updates;
  const linear = createLinearWatch({ itemStore, queue, now, accounts });
  const teams = createTeamsWatch({ itemStore, queue, now, me });
  const nameOf = (action: string) => gate.actions().find((each) => each.action === action)?.name ?? action;
  const sectionOfItem = (itemId: string | undefined): UpdateSection => {
    const kind = itemId ? itemStore.get(itemId)?.item.kind : undefined;
    return (kind && SECTION_OF_KIND[kind]) || 'ares';
  };

  // The Item that caused a suggestion: the one it names, else the one its causing entry changed.
  function causeOf(record: ProposalRecord): string | null {
    const cause = record.causedBy;
    if (!cause) return null;
    if (cause.itemId) return cause.itemId;
    return cause.entryId ? (itemStore.entry(cause.entryId)?.itemId ?? null) : null;
  }

  function suggestionKept(record: ProposalRecord) {
    const name = nameOf(record.action);
    const section = record.section ?? sectionOfItem(record.itemId);
    if (record.chained) {
      const cause = causeOf(record);
      queue.enqueue({
        group: 'decision',
        mergeKey: `chained:${record.id}`,
        about: {
          kind: 'chained',
          action: record.action,
          name,
          actionKind: record.actionKind,
          proposalId: record.id,
        },
        itemIds: cause && cause !== record.itemId ? [record.itemId, cause] : [record.itemId],
        section,
        importance: IMPORTANCE.chained,
      });
      return;
    }
    queue.enqueue({
      group: 'decision',
      mergeKey: `suggestions:${record.action}`,
      about: {
        kind: 'suggestions',
        action: record.action,
        name,
        actionKind: record.actionKind,
        proposalIds: [record.id],
      },
      itemIds: [record.itemId],
      section,
      importance: IMPORTANCE.suggestions,
    });
  }

  // New Ask suggestions since the producers last looked.
  function suggestions() {
    const cursor = store.state().proposalsCursor ?? 0;
    const newest = itemStore.autonomy.proposals({ limit: 1 })[0]?.id ?? 0;
    if (newest <= cursor) return;
    const kept = itemStore.autonomy
      .proposals({ statuses: ['pending'], limit: 1000 })
      .filter((record) => record.id > cursor && record.decision === 'ask')
      .reverse();
    for (const record of kept) suggestionKept(record);
    store.saveState({ proposalsCursor: newest });
  }

  // Suggestion lines lose what was settled elsewhere; a line with nothing left is resolved.
  function settled() {
    for (const line of store.lines(['queued'])) {
      const { about } = line;
      if (about.kind !== 'suggestions' && about.kind !== 'chained') continue;
      const ids = about.kind === 'suggestions' ? about.proposalIds : [about.proposalId];
      const pending = ids
        .map((id) => itemStore.autonomy.proposal(id))
        .filter((record): record is ProposalRecord => record?.status === 'pending');
      if (!pending.length) queue.resolve(line.id);
      else if (about.kind === 'suggestions' && pending.length < ids.length) {
        queue.revise(line.id, {
          about: { ...about, proposalIds: pending.map((record) => record.id) },
          itemIds: [...new Set(pending.map((record) => record.itemId))],
        });
      }
    }
  }

  // Outside Items whose text read like an instruction to Ares, while their mark stands: one the User
  // said is not an instruction (or whose words changed) leaves its line, and a line left with none
  // is resolved.
  function injectionWarnings() {
    const standing = (itemId: string) => itemStore.injectionWarnings.warning(itemId) !== null;
    for (const line of store.lines(['queued'])) {
      if (line.about.kind !== 'injection-warnings') continue;
      const itemIds = line.itemIds.filter(standing);
      if (!itemIds.length) queue.resolve(line.id);
      else if (itemIds.length < line.itemIds.length) queue.revise(line.id, { about: line.about, itemIds });
    }
    const cursor = store.state().warningsCursor;
    const entries: ActivityEntry[] = itemStore.injectionWarnings.since(cursor);
    if (!entries.length) return;
    const marked = entries.filter((entry) => standing(entry.itemId));
    const itemIds = [...new Set(marked.map((entry) => entry.itemId))];
    if (marked.length) {
      queue.enqueue({
        group: 'fyi',
        mergeKey: 'injection-warnings',
        about: { kind: 'injection-warnings', entryIds: marked.map((entry) => entry.id) },
        itemIds,
        section: sectionOfItem(itemIds[0]),
        importance: IMPORTANCE.warnings,
      });
    }
    store.saveState({ warningsCursor: entries.at(-1)?.id ?? cursor });
  }

  function capWarning() {
    const at = now();
    const month = monthKey(at);
    const warning = store.capWarning(month);
    const mergeKey = `cap-warning:${month}`;
    if (!warning || store.lastWithKey(mergeKey)) return;
    queue.enqueue({
      group: 'fyi',
      mergeKey,
      about: { kind: 'cap-warning', month, spentUsd: warning.spentUsd, capUsd: warning.capUsd },
      itemIds: [],
      section: 'ares',
      importance: IMPORTANCE.cap,
      expiresAt: nextMonth(at),
    });
  }

  // "You've accepted my last 20 … without changing any. Want me to just do them?"
  function autonomyChanges() {
    const settledRecords = itemStore.autonomy.proposals({ statuses: ['accepted', 'dismissed'], limit: 1000 });
    for (const { action, actionKind } of gate.actions()) {
      const mergeKey = `autonomy:${action}`;
      const offered = store.lastWithKey(mergeKey);
      if (offered?.status === 'queued') continue;
      const after = offered?.about.kind === 'autonomy-change' ? offered.about.lastProposalId : 0;
      // The suggestions the User settled since the last offer, newest first. Chained ones always
      // ask whatever the level, so they don't count.
      const run = settledRecords
        .filter(
          (record) =>
            record.action === action && record.decision === 'ask' && !record.chained && record.id > after,
        )
        .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0) || b.id - a.id)
        .slice(0, STREAK);
      if (run.length < STREAK || run.some((record) => record.status !== 'accepted')) continue;
      if (itemStore.undone(run.flatMap((record) => record.entryIds)).length) continue;
      const newest = run[0] as ProposalRecord;
      const chosen = chosenLevel(gate.settings(), { action, actionKind, section: newest.section });
      const level = isAllowed(actionKind, chosen) ? chosen : HARD_LIMITS[actionKind];
      const next = autonomyLevels[autonomyLevels.indexOf(level) + 1];
      if (level === 'off' || !next || !isAllowed(actionKind, next)) continue;
      queue.enqueue({
        group: 'decision',
        mergeKey,
        about: {
          kind: 'autonomy-change',
          action,
          name: nameOf(action),
          actionKind,
          section: newest.section,
          from: level,
          to: next,
          accepted: STREAK,
          lastProposalId: Math.max(...run.map((record) => record.id)),
        },
        itemIds: [],
        section: newest.section ?? 'ares',
        importance: IMPORTANCE.autonomy,
      });
    }
  }

  // "Always file Linear team OPS under TX?" (rule-suggestions.ts).
  const ruleSuggestions = createRuleSuggestions({ itemStore, queue });
  // "Always put mail from stripe.com in Receipts?" (bucket-rule-suggestions.ts, #141).
  const bucketRuleSuggestions = createBucketRuleSuggestions({ itemStore, queue });
  const githubSummaries = createGitHubSummaryWatch({ itemStore, queue });

  return {
    sweep() {
      suggestions();
      settled();
      injectionWarnings();
      capWarning();
      autonomyChanges();
      linear.sweep();
      teams.sweep();
      ruleSuggestions.sweep();
      bucketRuleSuggestions.sweep();
      githubSummaries.sweep();
    },
  };
}
