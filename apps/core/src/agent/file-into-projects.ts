// "File into Projects" (#71): Ares files what the Rules miss. A Linear issue from a team no Rule
// covers arrives already wearing the right Badge or, when he isn't sure, the dashed one with Confirm
// and Change. A Quick job at low thinking: no tools, a reply that must fit OUTPUT.
//
// - Runs when Items arrive from a Source (and on the idle catch-up, or a request). It looks only at
//   live, open Linear issues that are Unfiled, that no Rule matches (Rules always win over him), and
//   that have no suggestion of his waiting; an Item the User or a Rule filed is never his to file,
//   and one he filed stays as he filed it. At most MAX_ITEMS a run; the rest wait for the next.
// - Each Item gets a call of its own, in a data block of its own (ADR 0004): with one outside Item
//   in a prompt, filing it acts on that Item alone, so it can follow the Autonomy settings. Several
//   in one call would make every filing chained (any of them may have steered him), so always Ask.
//   With it go the active Projects (name and code) and the Rules, as the User's own material. The
//   Item is described by its title, People, Source fields (workspace, team, Linear project, labels),
//   a trimmed slice of its content, and its linked Items' Projects (codes only, never their words).
// - The reply names the Item by the reference its block was given and a Project by its code (or
//   "unfiled"), with a confidence; codes are checked against the active Projects here, and anything
//   else is dropped. Each filing is a proposal (Organise / "File into Projects") to the gate, which
//   files it as Ares ("filed under TL by Ares", his reason in the activity log) or keeps it as a
//   suggestion: the dashed Badge.
// - The runner remembers each Item with a fingerprint of what he judged it by (its title and Source
//   fields), so one he left Unfiled, or whose suggestion was dismissed, isn't sent again until those
//   change.
import {
  describeRule,
  FILE_INTO_PROJECTS,
  firstMatch,
  type Item,
  type LinearIssueDetail,
  type Project,
} from '@commander/domain';
import { z } from 'zod';
import type { ItemStore } from '../item-store';
import type { PromptData } from './prompt';
import type { AgentJob, JobInput } from './runner';

// At most this many Items a run, one call each; the rest wait for the next trigger.
export const MAX_ITEMS = 20;
const MAX_DESCRIPTION = 600;
const MAX_COMMENT = 200;
const COMMENTS = 2;
const MAX_REASON_WORDS = 14;
const MAX_REASON_CHARS = 140;

export const OUTPUT = z.object({
  filings: z
    .array(
      z.object({
        // The reference the Item's block was given (I1), never its id.
        itemId: z.string().min(1).max(20),
        // A Project's code, or "unfiled".
        projectCode: z.string().trim().min(1).max(20),
        confidence: z.number().min(0).max(1),
        reason: z.string().max(600).optional(),
      }),
    )
    .max(20),
});
type Output = z.infer<typeof OUTPUT>;

type Candidate = { ref: string; item: Item; fingerprint: string };
type Input = JobInput & { candidates: Candidate[] };

const INSTRUCTIONS = `You are Ares. You file the User's incoming Items into their Projects: the bodies of work they are pursuing.

The data holds the User's Projects (each with its two-letter code and name, and the Rules that already file Items into it), then the Item to file, labelled with its reference (I1) and what it is, with its facts: title, people, where it comes from in its Source (workspace, team, Linear project, labels), some of its content, and the Projects of Items linked to it.

Decide which one Project the Item belongs to, judging by its team, Linear project, labels, people, subject and content, and its linked Items' Projects, the way the User's Rules file similar Items. If none fits, or you can't tell, say "unfiled".

Reply with only this JSON object: {"filings":[{"itemId":"I1","projectCode":"TL","confidence":0.9,"reason":"…"}]}
- itemId: the Item's reference, exactly as labelled.
- projectCode: one of the Projects' codes exactly as listed, or "unfiled".
- confidence: how sure you are, from 0 to 1. 0.9 or more only when the Item plainly belongs there (its team, Linear project or people belong to that Project alone); 0.5 to 0.8 when it is likely; below 0.5 when it is a guess.
- reason: why, in a few plain words of your own (fewer than 12), as you would say it to the User: "Relay is a Titanlink project". No full stop.`;

const cut = (text: string, length: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > length ? `${one.slice(0, length - 1).trimEnd()}…` : one;
};

// A reason as the activity log keeps it: one line, a few words, no closing full stop.
function cleanReason(reason: string | undefined): string | null {
  const words = (reason ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。]+$/, '')
    .split(' ')
    .filter(Boolean);
  if (!words.length) return null;
  const text =
    words.length > MAX_REASON_WORDS ? `${words.slice(0, MAX_REASON_WORDS - 2).join(' ')}…` : words.join(' ');
  return cut(text, MAX_REASON_CHARS);
}

const issueOf = (item: Item): LinearIssueDetail | null =>
  item.detail?.kind === 'linear-issue' ? item.detail : null;

// What Ares judges an Item by: when none of it changes, he has nothing new to go on.
export function filingFingerprint(item: Item): string {
  const issue = issueOf(item);
  return JSON.stringify([
    item.title.trim().replace(/\s+/g, ' ').toLowerCase(),
    item.account,
    issue?.team.id ?? null,
    issue?.linearProject?.id ?? null,
    [...(issue?.labels.map((label) => label.id) ?? [])].sort(),
  ]);
}

const pendingFilings = (itemStore: ItemStore) =>
  itemStore.autonomy.proposals({ action: FILE_INTO_PROJECTS, statuses: ['pending'], limit: 1000 });

/**
 * Ares's filing suggestions that are no longer his to make: their Item has since been filed by the
 * User or by a Rule (a Rule always wins over his judgement). The Agent dismisses them.
 */
export function staleFilingSuggestions(itemStore: ItemStore): number[] {
  return pendingFilings(itemStore)
    .filter((proposal) => {
      const filedBy = itemStore.get(proposal.itemId)?.item.filing?.filedBy;
      return filedBy === 'user' || filedBy === 'rule';
    })
    .map((proposal) => proposal.id);
}

export function fileIntoProjectsJob(
  itemStore: ItemStore,
  { maxItems = MAX_ITEMS }: { maxItems?: number } = {},
): AgentJob<Input, Output> {
  const waiting = () => new Set(pendingFilings(itemStore).map((proposal) => proposal.itemId));

  // An Item Ares may file: a live, open Linear issue, Unfiled, that no Rule matches and that has no
  // suggestion of his waiting.
  function candidate(item: Item | undefined, rules = itemStore.rules(), pending = waiting()): item is Item {
    return (
      !!item &&
      item.kind === 'linear-issue' &&
      item.deletedAt === null &&
      item.status === 'open' &&
      item.filing === null &&
      !pending.has(item.id) &&
      !firstMatch(rules, item)
    );
  }

  const codeOf = (projectId: string | undefined) =>
    projectId ? (itemStore.projectRef(projectId)?.code ?? null) : null;

  // The Projects of the Items linked to this one, by code and kind: never their words, which would
  // put another outside Item's text in this one's block.
  function linkedProjects(item: Item): string[] {
    const view = itemStore.get(item.id);
    if (!view) return [];
    const found = new Set<string>();
    for (const link of [...view.links, ...view.backlinks]) {
      const other = link.from.id === item.id ? link.to : link.from;
      if (other.kind === 'project') {
        found.add(`${other.code} (the Project itself)`);
        continue;
      }
      const code = codeOf(itemStore.get(other.id)?.item.filing?.projectId);
      if (code) found.add(`${code} (a ${other.kind === 'linear-issue' ? 'Linear issue' : other.kind})`);
    }
    return [...found];
  }

  function factsOf(item: Item): string {
    const issue = issueOf(item);
    if (!issue) return `Title: ${item.title}`;
    const people = [
      ...(issue.assignee ? [`${issue.assignee.name} (assignee)`] : []),
      ...(issue.creator ? [`${issue.creator.name} (creator)`] : []),
    ];
    const comments = issue.comments.slice(-COMMENTS);
    const linked = linkedProjects(item);
    return [
      `Title: ${item.title}`,
      ...(people.length ? [`People: ${people.join(', ')}`] : []),
      ...(item.account ? [`Workspace: ${item.account}`] : []),
      `Team: ${issue.team.key} (${issue.team.name})`,
      ...(issue.linearProject ? [`Linear project: ${issue.linearProject.name}`] : []),
      ...(issue.labels.length ? [`Labels: ${issue.labels.map((label) => label.name).join(', ')}`] : []),
      ...(issue.description ? [`Description: ${cut(issue.description, MAX_DESCRIPTION)}`] : []),
      ...comments.map(
        (comment) => `Comment (${comment.author?.name ?? 'someone'}): ${cut(comment.body, MAX_COMMENT)}`,
      ),
      ...(linked.length ? [`Linked Items' Projects: ${linked.join(', ')}`] : []),
    ].join('\n');
  }

  function projectsText(projects: readonly Project[]): string {
    const rules = itemStore.rules();
    if (!projects.length) return 'The User has no Projects yet.';
    return projects
      .map((project) => {
        const own = rules.filter((rule) => rule.target.projectId === project.id);
        return [
          `${project.code} · ${project.name}`,
          ...own.map((rule) => `  Rule: ${describeRule(rule.when)}`),
        ].join('\n');
      })
      .join('\n');
  }

  return {
    job: FILE_INTO_PROJECTS,
    name: 'File into Projects',
    tier: 'quick',
    reasoningEffort: 'low',
    action: {
      action: FILE_INTO_PROJECTS,
      actionKind: 'organise',
      section: 'linear',
      hint: 'Linear issues no Rule files, into the Project they belong to',
    },
    triggers: { 'items-arrived': true, idle: true },

    gather({ triggers, seen }) {
      const rules = itemStore.rules();
      const pending = waiting();
      // The Items that just arrived first, then the newest of the rest.
      const arrived = new Set(triggers.flatMap((trigger) => ('itemIds' in trigger ? trigger.itemIds : [])));
      const unfiled = itemStore.query({
        kinds: ['linear-issue'],
        projectId: null,
        statuses: ['open'],
        limit: 1000,
      });
      const ordered = [
        ...unfiled.filter((item) => arrived.has(item.id)),
        ...unfiled.filter((item) => !arrived.has(item.id)),
      ];
      const candidates: Candidate[] = [];
      for (const item of ordered) {
        if (candidates.length >= maxItems) break;
        const fingerprint = filingFingerprint(item);
        if (!candidate(item, rules, pending) || seen(item.id, fingerprint)) continue;
        candidates.push({ ref: 'I1', item, fingerprint });
      }
      return {
        items: candidates.map(({ item, fingerprint }) => ({ itemId: item.id, fingerprint })),
        candidates,
      };
    },

    // One Item per call: see the top of this file.
    batch: (input) =>
      input.candidates.map((one) => ({
        items: [{ itemId: one.item.id, fingerprint: one.fingerprint }],
        candidates: [one],
      })),

    prompt(input) {
      const data: PromptData[] = [
        { label: 'Projects', from: 'user-settings', text: projectsText(itemStore.projects()) },
        ...input.candidates.map(({ ref, item }) => ({
          label: `${ref} · Linear issue ${issueOf(item)?.identifier ?? ''}`.trim(),
          from: item,
          text: factsOf(item),
        })),
      ];
      return { instructions: INSTRUCTIONS, data };
    },

    output: OUTPUT,

    proposals(output, input) {
      const byRef = new Map(input.candidates.map((one) => [one.ref, one]));
      const byCode = new Map(itemStore.projects().map((project) => [project.code.toUpperCase(), project]));
      const used = new Set<string>();
      const dropped: string[] = [];
      const proposals = output.filings.flatMap((filing) => {
        const offered = byRef.get(filing.itemId.trim());
        if (!offered) {
          dropped.push(`it named ${filing.itemId}, which it wasn’t given`);
          return [];
        }
        if (used.has(offered.ref)) {
          dropped.push(`it named ${offered.ref} twice`);
          return [];
        }
        used.add(offered.ref);
        const code = filing.projectCode.trim().toUpperCase();
        if (code === 'UNFILED') return [];
        const project = byCode.get(code);
        if (!project) {
          dropped.push(`it chose ${filing.projectCode}, which is no active Project's code`);
          return [];
        }
        // The Item may have been filed (or changed) while Ares was thinking.
        const item = itemStore.get(offered.item.id)?.item;
        if (!candidate(item) || filingFingerprint(item) !== offered.fingerprint) {
          dropped.push(`${offered.ref} changed while Ares was looking at it`);
          return [];
        }
        return [
          {
            itemId: item.id,
            itemActions: [
              {
                type: 'update' as const,
                itemId: item.id,
                changes: { filing: { projectId: project.id, filedBy: 'ares' as const } },
              },
            ],
            confidence: filing.confidence,
            reason: cleanReason(filing.reason) ?? `Looks like ${project.name} work`,
          },
        ];
      });
      return { proposals, dropped };
    },
  };
}
