// Ares spots stuck Linear issues (#75): after each Linear sync, he looks at the User's open issues
// (assigned to them or created by them) that a code pre-filter picks as possibly stuck (the domain's
// linear-stuck.ts: started and unchanged for 5 working days, in review with no change for 3 days,
// blocked by an open issue, or overdue), decides for each whether it really is, and says why in one
// short sentence. A Quick job at low thinking: one call per batch of 20, no tools, a reply that must
// fit OUTPUT ({ ref, stuck, reason } per issue).
//
// - Each issue goes in a data block of its own through the prompt builder (ADR 0004), labelled with a
//   short reference (S1, S2…) the reply names it by, with its facts and why it was picked. Linear
//   issues are outside material: what they say is never an instruction.
// - The issues judged stuck go in Ares's queue as For your information lines, merged by team; the
//   Updates' producers take an issue out of its line once it changes (updates/linear.ts). Each issue
//   is remembered as it was when judged (by when it last changed), so it isn't looked at, or raised,
//   again until it changes and stalls again.
// - The result changes no Item and writes nothing to Linear: the runner `apply`s it without the gate
//   (ADR 0004's amendment), at any level above Off. Ask works as Auto here, as there is nothing to
//   approve. Status changes and comments Ares might propose come with his Linear actions Skill (M7),
//   through the gate.
import {
  type Enqueue,
  type Item,
  isReviewState,
  type LinearIssueDetail,
  lastChangedAt,
  localDay,
  SPOT_STUCK_LINEAR,
  type StuckSignal,
  stuckSignals,
} from '@commander/domain';
import { z } from 'zod';
import type { ItemStore } from '../item-store';
import type { PromptData } from './prompt';
import type { AgentJob, JobInput } from './runner';

export const BATCH_SIZE = 20;
// At most this many issues a run (five calls), those unchanged longest first.
const MAX_CANDIDATES = 100;
const MAX_REASON = 240;
const MAX_DESCRIPTION = 300;
const MAX_COMMENT = 240;
const COMMENTS = 3;
const IMPORTANCE = 0.5;

// Each entry is checked on its own (so one bad entry costs only that issue), hence the loose shape.
const entry = z
  .object({
    ref: z.string().max(20),
    stuck: z.boolean(),
    reason: z.string().max(1000).optional().default(''),
  })
  .nullable()
  .catch(null);
export const OUTPUT = z.object({ issues: z.array(entry).max(200) });
type Output = z.infer<typeof OUTPUT>;

type Issue = Item & { detail: LinearIssueDetail };
type Candidate = {
  ref: string;
  itemId: string;
  identifier: string;
  team: LinearIssueDetail['team'];
  changedAt: number;
  data: PromptData;
};
type Input = JobInput & { candidates: Candidate[] };

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const PRIORITIES = ['None', 'Urgent', 'High', 'Medium', 'Low'];
const pad = (n: number) => String(n).padStart(2, '0');
const longDay = (at: number) => {
  const date = new Date(at);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
};
const clockTime = (at: number) => {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const cut = (text: string, length: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > length ? `${one.slice(0, length - 1).trimEnd()}…` : one;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const instructions = (
  now: number,
) => `You are Ares. You keep an eye on the User's Linear issues and tell them, in their Update, when one has stalled.

Today is ${longDay(now)} (${localDay(now)}); the time is ${clockTime(now)}.

Each data block is one of the User's Linear issues (assigned to them or created by them) that a simple check picked as possibly stuck, labelled with its reference (S1, S2…), then its facts and why it was picked. Decide for each whether it really is stuck: nothing is moving it on, and the User would want to know. It isn't stuck when it is plainly waiting for something planned (a release, a date still ahead), or someone is clearly working on it.

Reply with only this JSON object: {"issues":[{"ref":"S1","stuck":true,"reason":"…"}]}
- One entry for every issue, by its reference exactly as labelled.
- stuck: true or false.
- reason: when stuck, one short plain sentence for the User saying what has stalled, starting with the issue's identifier, as in "ENG-402 has sat in review for 4 days; Priya hasn't looked at it yet". Use only what the issue shows. No links. When not stuck, it may be empty.`;

// Why the pre-filter picked it, in plain words.
function signalText(signal: StuckSignal): string {
  switch (signal.kind) {
    case 'unchanged':
      return `No change for ${plural(signal.workingDays, 'working day')} (since ${localDay(signal.since)})`;
    case 'in-review':
      return `In review since ${localDay(signal.since)} (${plural(signal.days, 'day')}), no change for ${plural(signal.quietDays, 'day')}`;
    case 'blocked':
      return signal.by
        .map((by) => `Blocked by ${by.identifier} “${cut(by.title, 120)}”, still open`)
        .join('\n');
    case 'overdue':
      return `Overdue: due ${signal.dueDate} (${plural(signal.days, 'day')} ago)`;
  }
}

// A reason as the Update shows it: one line, no links, not too long.
function cleanReason(reason: string): string {
  const text = reason
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/[\s:;,–—-]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cut(text, MAX_REASON);
}

export function spotStuckLinearJob(
  itemStore: ItemStore,
  {
    now = Date.now,
    batchSize = BATCH_SIZE,
    enqueue,
    me,
  }: {
    now?: () => number;
    batchSize?: number;
    // Where the issues judged stuck go: Ares's queue.
    enqueue: (input: Enqueue) => unknown;
    // Who the User is in a Linear Account (their Linear user id), from Source sync, when known.
    me?: (account: string) => string | null;
  },
): AgentJob<Input, Output> {
  // Who the User is in each Account, failing `me`: the assignee of the issues behind their Linear Todos.
  function usersFromTodos(byId: Map<string, Item>): Record<string, string> {
    const users: Record<string, string> = {};
    for (const todo of itemStore.query({ kinds: ['todo'], statuses: ['open'], limit: 1000 })) {
      const backedBy = todo.detail?.kind === 'todo' ? todo.detail.backedBy : null;
      const issue = backedBy ? byId.get(backedBy) : undefined;
      if (issue?.account && issue.detail?.kind === 'linear-issue' && issue.detail.assignee)
        users[issue.account] = issue.detail.assignee.id;
    }
    return users;
  }

  // When the issue went into the state it is in, as Linear dated the change Commander saw (null when
  // it was already in it when Commander first saw it).
  function enteredStateAt(issue: Issue): number | null {
    for (const logged of itemStore.activity({ itemId: issue.id, limit: 200 })) {
      if (logged.itemId !== issue.id) continue;
      const change = logged.changes.find((each) => each.field === 'detail');
      const before = change?.before as LinearIssueDetail | null | undefined;
      const after = change?.after as LinearIssueDetail | null | undefined;
      if (before?.kind !== 'linear-issue' || after?.kind !== 'linear-issue') continue;
      if (before.state.id === after.state.id) continue;
      return after.state.id === issue.detail.state.id ? after.updatedAt : null;
    }
    return null;
  }

  function blockerState(account: string | null, externalId: string): string | null {
    if (!account) return null;
    const [blocker] = itemStore.fromSource({ source: 'linear', account }, [externalId]);
    return blocker?.detail?.kind === 'linear-issue' ? blocker.detail.state.type : null;
  }

  function issueText(issue: Issue, mine: string | null, signals: StuckSignal[], at: number): string {
    const { detail } = issue;
    const { assignee, creator, cycle } = detail;
    const whose =
      assignee?.id === mine
        ? `Assigned to the User${creator && creator.id !== mine ? `; created by ${creator.name}` : ''}`
        : `${assignee ? `Assigned to ${assignee.name}` : 'Unassigned'}; the User created it`;
    const changed = lastChangedAt(detail);
    const comments = detail.comments.slice(-COMMENTS);
    return [
      `Identifier: ${detail.identifier}`,
      `Title: ${issue.title}`,
      `Team: ${detail.team.name}`,
      `State: ${detail.state.name} (${detail.state.type})`,
      whose,
      `Priority: ${PRIORITIES[detail.priority] ?? 'None'}`,
      `Due: ${detail.dueDate ?? 'no due date'}`,
      ...(cycle
        ? [`Cycle: ${cycle.number}${cycle.startsAt <= at && at < cycle.endsAt ? ' (current)' : ''}`]
        : []),
      ...(detail.linearProject ? [`Linear project: ${detail.linearProject.name}`] : []),
      `Last change: ${localDay(changed)} ${clockTime(changed)}`,
      'Why it was picked:',
      ...signals.flatMap((signal) => signalText(signal).split('\n')).map((line) => `- ${line}`),
      ...(detail.description ? [`Description: ${cut(detail.description, MAX_DESCRIPTION)}`] : []),
      ...(comments.length
        ? [
            'Latest comments (oldest first):',
            ...comments.map(
              (comment) =>
                `- ${comment.author?.name ?? 'Someone'}, ${localDay(comment.createdAt)}: ${cut(comment.body, MAX_COMMENT)}`,
            ),
          ]
        : []),
    ].join('\n');
  }

  return {
    job: SPOT_STUCK_LINEAR,
    name: 'Spot stuck Linear issues',
    tier: 'quick',
    reasoningEffort: 'low',
    action: {
      action: SPOT_STUCK_LINEAR,
      actionKind: 'organise',
      section: 'linear',
      hint: 'Tells you in your Update when one of your Linear issues looks stuck. Ask works as Auto here: there is nothing to approve',
    },
    triggers: { 'source-sync': true },

    gather({ triggers, seen }) {
      // After a Linear sync (or on request), not another Source's.
      const linear = triggers.some(
        (trigger) =>
          trigger.kind === 'request' || (trigger.kind === 'source-sync' && trigger.source === 'linear'),
      );
      if (!linear) return null;
      const at = now();
      const issues = itemStore
        .query({ kinds: ['linear-issue'], statuses: ['open'], limit: 1000 })
        .filter((item): item is Issue => item.detail?.kind === 'linear-issue' && item.deletedAt === null);
      const users = usersFromTodos(new Map(issues.map((issue) => [issue.id, issue])));

      const picked: (Omit<Candidate, 'ref' | 'data'> & { data: Omit<PromptData, 'label'> })[] = [];
      for (const issue of issues) {
        const account = issue.account;
        const mine = (account && (me?.(account) ?? users[account])) || null;
        if (mine === null) continue;
        const changedAt = lastChangedAt(issue.detail);
        if (seen(issue.id, String(changedAt))) continue;
        const signals = stuckSignals(issue.detail, {
          me: mine,
          now: at,
          reviewSince: isReviewState(issue.detail.state) ? enteredStateAt(issue) : null,
          blockerState: (id) => blockerState(account, id),
        });
        if (!signals.length) continue;
        picked.push({
          itemId: issue.id,
          identifier: issue.detail.identifier,
          team: issue.detail.team,
          changedAt,
          data: { from: issue, text: issueText(issue, mine, signals, at) },
        });
      }
      const candidates: Candidate[] = picked
        .sort((a, b) => a.changedAt - b.changedAt || (a.itemId < b.itemId ? -1 : 1))
        .slice(0, MAX_CANDIDATES)
        .map((candidate, index) => {
          const ref = `S${index + 1}`;
          return {
            ...candidate,
            ref,
            data: { ...candidate.data, label: `${ref} · Linear issue ${candidate.identifier}` },
          };
        });
      return {
        items: candidates.map((candidate) => ({
          itemId: candidate.itemId,
          fingerprint: String(candidate.changedAt),
        })),
        candidates,
      };
    },

    batch(input) {
      const parts: Input[] = [];
      for (let start = 0; start < input.candidates.length; start += batchSize) {
        parts.push({
          items: input.items.slice(start, start + batchSize),
          candidates: input.candidates.slice(start, start + batchSize),
        });
      }
      return parts;
    },

    prompt: (input) => ({
      instructions: instructions(now()),
      data: input.candidates.map((candidate) => candidate.data),
    }),

    output: OUTPUT,

    apply(answers) {
      const dropped: string[] = [];
      const judged = new Set<string>();
      for (const { output, input: part } of answers) {
        const byRef = new Map(part.candidates.map((candidate) => [candidate.ref, candidate]));
        for (const raw of output.issues) {
          if (!raw) {
            dropped.push('an entry that wasn’t one');
            continue;
          }
          const candidate = byRef.get(raw.ref.trim());
          if (!candidate) {
            dropped.push(`it named ${raw.ref}, which it wasn’t given`);
            continue;
          }
          if (judged.has(candidate.itemId)) {
            dropped.push(`it named ${raw.ref} twice`);
            continue;
          }
          judged.add(candidate.itemId);
          if (!raw.stuck) continue;
          const reason = cleanReason(raw.reason);
          if (!reason) {
            dropped.push(`${raw.ref}: stuck, but no reason`);
            continue;
          }
          enqueue({
            group: 'fyi',
            mergeKey: `linear-stuck:${candidate.team.id}`,
            about: {
              kind: 'linear-stuck',
              team: candidate.team,
              issues: [
                {
                  itemId: candidate.itemId,
                  identifier: candidate.identifier,
                  reason,
                  changedAt: candidate.changedAt,
                },
              ],
            },
            itemIds: [candidate.itemId],
            section: 'linear',
            importance: IMPORTANCE,
          });
        }
        const left = part.candidates.filter((candidate) => !judged.has(candidate.itemId)).length;
        if (left) dropped.push(`${left} issue(s) it didn’t judge`);
      }
      return { dropped };
    },
  };
}
