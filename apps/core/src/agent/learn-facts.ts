// "Learn facts" (#74): Ares picks up facts about People and Projects ("Priya works mostly on TL",
// "Longtail's beta launches in November") from what the User writes in Daily Notes and from Linear
// issues, and keeps them in Memory. A Quick job at low thinking, run when the machine is idle (and on
// request), batched.
//
// - Looks at the Blocks the User changed since its last run (today's note on its first run and on
//   each catch-up) and the Linear issues changed most recently, each not looked at before as it now
//   is (the runner's fingerprints): a Block by its text, an issue by its title, description and
//   comments. At most MAX_BLOCKS Blocks and MAX_ISSUES issues a run; the rest wait.
// - The Blocks go together in one call, as the User's own words. Each issue goes in a call of its own,
//   in an outside block (ADR 0004): with one outside Item in a prompt, whatever it says can only put
//   facts on itself, never pass them off as another's.
// - The reply names, for each fact, the reference of where it came from (B1, I1), the fact in plain
//   words, and who (a person's name) and what (a Project's code) it is about. A ref it wasn't given,
//   a code that isn't an active Project's, and a fact about no known Person or Project are dropped.
//   A person is found among the issue's own people, or (from a Block) among People by their whole
//   name or a first name only one of them has; never guessed further (ADR 0005).
// - It writes Memory, not Items, so nothing goes to the gate (ADR 0004's fifth amendment, ADR 0006):
//   a fact from the User's Block is confirmed; one from an issue is unconfirmed, only ever background
//   to Ares until the User confirms it in What Ares knows. Each keeps its source; the same fact seen
//   again gains another.
import {
  type Item,
  identitiesOf,
  LEARN_FACTS,
  type LinearIssueDetail,
  normaliseHandle,
  type Person,
} from '@commander/domain';
import { z } from 'zod';
import type { ItemStore } from '../item-store';
import { trustOf } from '../safety/trust';
import type { PromptData } from './prompt';
import type { AgentJob, JobInput } from './runner';

const MAX_BLOCKS = 40;
const MAX_ISSUES = 10;
// Recent Linear issues looked through for ones changed since Ares last read them.
const RECENT_ISSUES = 200;
const MAX_DESCRIPTION = 1200;
const MAX_COMMENT = 300;
const COMMENTS = 3;
const MIN_BLOCK = 12;
const MAX_FACT = 200;

export const OUTPUT = z.object({
  facts: z
    .array(
      z.object({
        // Where it came from: a Block's or the issue's reference (B1, I1), never an id.
        from: z.string().min(1).max(20),
        text: z.string().trim().min(1).max(400),
        // Who it is about, by name, and which Project, by its code.
        person: z.string().trim().max(120).optional(),
        projectCode: z.string().trim().max(20).optional(),
      }),
    )
    .max(20),
});
type Output = z.infer<typeof OUTPUT>;

type Offered = { ref: string; item: Item };
type Input = JobInput & { blocks: Offered[]; issues: Offered[] };

const INSTRUCTIONS = `You are Ares. You pick up facts about the People the User works with and the User's Projects, to remember them.

The data holds the User's Projects (each with its two-letter code and name), then either some of the User's own Daily Note Blocks, each marked with a reference ([B1], [B2]…), or one Linear issue, labelled with its reference (I1), with its people and content.

Find the lasting facts about People and Projects in it: who works on or leads what, what a Project is, what is planned and when ("Priya works mostly on Titanlink", "Longtail's beta launches in November", "Dana leads the reliability push"). Leave out tasks and to-dos, passing remarks, opinions, anything about the User's private life, and anything not about a person or a Project. Few, plain facts are better than many; an empty list is fine.

Reply with only this JSON object: {"facts":[{"from":"B1","text":"…","person":"Priya Patel","projectCode":"TL"}]}
- from: the reference of the Block or issue the fact is in, exactly as marked.
- text: the fact in one short plain sentence, naming who or what it is about. No full stop.
- person: the name of the person it is about, as written, if it is about one; otherwise leave it out.
- projectCode: the code of the Project it is about, exactly as listed, if it is about one; otherwise leave it out.`;

const cut = (text: string, length: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > length ? `${one.slice(0, length - 1).trimEnd()}…` : one;
};

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (at: number) => {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const textOf = (item: Item) => (item.detail?.kind === 'block' ? item.detail.text : '');
const issueOf = (item: Item): LinearIssueDetail | null =>
  item.detail?.kind === 'linear-issue' ? item.detail : null;

const fingerprint = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The key a fact (or a preference the User told Ares, #194) is learned under: the same words learned
 * again, from anywhere, add to one memory.
 */
export const factKey = (text: string, kind: 'fact' | 'preference' = 'fact') => `${kind}:${fingerprint(text)}`;

// What Ares reads an issue by: when none of it changes, there is nothing new to learn.
function issueFingerprint(item: Item): string {
  const issue = issueOf(item);
  return fingerprint(
    [
      item.title,
      issue?.description ?? '',
      ...(issue?.comments.slice(-COMMENTS).map((c) => c.body) ?? []),
    ].join('\n'),
  );
}

// A fact as Memory keeps it: one line, no closing full stop.
export function cleanFact(text: string): string {
  return cut(text, MAX_FACT).replace(/[.。]+$/, '');
}

const nameWords = (name: string) => name.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * The Person a fact names: among the issue's own people (for an issue), or among everyone but the
 * User by their whole name or a first name only one of them has (for the User's own words: a Block,
 * or what they told Ares in a Conversation, #194, with no Item). Null when it can't be told.
 */
export function personNamed(name: string | undefined, source: Item | null, people: Person[]): Person | null {
  const wanted = nameWords(name ?? '');
  if (!wanted.length) return null;
  const handleOwner = new Map<string, Person>();
  for (const person of people) {
    for (const { handle } of person.handles) handleOwner.set(normaliseHandle(handle), person);
  }
  const candidates =
    source?.kind === 'linear-issue'
      ? identitiesOf(source).flatMap((identity) => {
          const person = handleOwner.get(identity.handle);
          return person ? [person] : [];
        })
      : people.filter((person) => !person.isUser);
  const unique = [...new Map(candidates.map((person) => [person.id, person])).values()];
  const whole = unique.filter((person) => nameWords(person.name).join(' ') === wanted.join(' '));
  if (whole.length === 1) return whole[0] as Person;
  if (wanted.length === 1) {
    const first = unique.filter((person) => nameWords(person.name)[0] === wanted[0]);
    if (first.length === 1) return first[0] as Person;
  }
  return null;
}

export function learnFactsJob(
  itemStore: ItemStore,
  { now = Date.now }: { now?: () => number } = {},
): AgentJob<Input, Output> {
  function blockCandidate(itemId: string): Item | null {
    const item = itemStore.get(itemId)?.item;
    if (item?.kind !== 'block' || item.deletedAt !== null) return null;
    return textOf(item).trim().length >= MIN_BLOCK ? item : null;
  }

  function projectsText(): string {
    const projects = itemStore.projects();
    return projects.length
      ? projects.map((project) => `${project.code} · ${project.name}`).join('\n')
      : 'The User has no Projects yet.';
  }

  function issueText(item: Item): string {
    const issue = issueOf(item);
    if (!issue) return `Title: ${item.title}`;
    const people = [
      ...(issue.assignee ? [`${issue.assignee.name} (assignee)`] : []),
      ...(issue.creator ? [`${issue.creator.name} (creator)`] : []),
    ];
    return [
      `Title: ${item.title}`,
      ...(people.length ? [`People: ${people.join(', ')}`] : []),
      `Team: ${issue.team.key} (${issue.team.name})`,
      ...(issue.linearProject ? [`Linear project: ${issue.linearProject.name}`] : []),
      ...(issue.labels.length ? [`Labels: ${issue.labels.map((label) => label.name).join(', ')}`] : []),
      ...(issue.description ? [`Description: ${cut(issue.description, MAX_DESCRIPTION)}`] : []),
      ...issue.comments
        .slice(-COMMENTS)
        .map(
          (comment) => `Comment (${comment.author?.name ?? 'someone'}): ${cut(comment.body, MAX_COMMENT)}`,
        ),
    ].join('\n');
  }

  return {
    job: LEARN_FACTS,
    name: 'Learn facts',
    tier: 'quick',
    reasoningEffort: 'low',
    action: {
      action: LEARN_FACTS,
      actionKind: 'organise',
      section: null,
      hint: 'Facts about People and Projects from your Daily Notes and Linear issues, kept in What Ares knows. Ask works as Auto here: you confirm facts there',
    },
    triggers: { idle: true },

    gather({ triggers, cursor, seen }) {
      const changes = itemStore.agent.userChangesSince(cursor, ['block']);
      const ids = new Set(cursor === null ? [] : changes.itemIds);
      const catchUp = cursor === null || triggers.some((t) => t.kind === 'idle' || t.kind === 'request');
      if (catchUp) {
        const day = localDay(now());
        const today = itemStore.dailyNotes({ from: day, to: day, limit: 1 }).notes[0];
        if (today) for (const block of itemStore.blocks([today.item.id])) ids.add(block.id);
      }
      const blocks = [...ids]
        .map(blockCandidate)
        .filter((item): item is Item => item !== null && !seen(item.id, fingerprint(textOf(item))));
      const takenBlocks = blocks.slice(0, MAX_BLOCKS);
      const issues = itemStore
        .query({ kinds: ['linear-issue'], limit: RECENT_ISSUES })
        .filter((item) => !seen(item.id, issueFingerprint(item)))
        .slice(0, MAX_ISSUES);
      const next = blocks.length > MAX_BLOCKS ? (cursor ?? undefined) : changes.lastEntryId;
      return {
        items: [
          ...takenBlocks.map((item) => ({ itemId: item.id, fingerprint: fingerprint(textOf(item)) })),
          ...issues.map((item) => ({ itemId: item.id, fingerprint: issueFingerprint(item) })),
        ],
        ...(next !== undefined && { cursor: next }),
        blocks: takenBlocks.map((item, i) => ({ ref: `B${i + 1}`, item })),
        issues: issues.map((item) => ({ ref: 'I1', item })),
      };
    },

    // The Blocks in one call; each issue in a call of its own.
    batch(input) {
      const part = (blocks: Offered[], issues: Offered[]): Input => ({
        items: [...blocks, ...issues].map(({ item }) => ({
          itemId: item.id,
          fingerprint: item.kind === 'block' ? fingerprint(textOf(item)) : issueFingerprint(item),
        })),
        blocks,
        issues,
      });
      return [
        ...(input.blocks.length ? [part(input.blocks, [])] : []),
        ...input.issues.map((issue) => part([], [issue])),
      ];
    },

    prompt(input) {
      const data: PromptData[] = [{ label: 'Projects', from: 'user-settings', text: projectsText() }];
      if (input.blocks.length) {
        data.push({
          label: 'Daily Note Blocks',
          from: input.blocks.map(({ item }) => item),
          text: input.blocks
            .map(({ ref, item }) => `[${ref}] ${textOf(item).replace(/\s*\n\s*/g, ' ')}`)
            .join('\n'),
        });
      }
      for (const { ref, item } of input.issues) {
        data.push({
          label: `${ref} · Linear issue ${issueOf(item)?.identifier ?? ''}`.trim(),
          from: item,
          text: issueText(item),
        });
      }
      return { instructions: INSTRUCTIONS, data };
    },

    output: OUTPUT,

    apply(answers) {
      const dropped: string[] = [];
      const byCode = new Map(itemStore.projects().map((project) => [project.code.toUpperCase(), project]));
      const people = itemStore.people.list();
      for (const { output, input } of answers) {
        const byRef = new Map(
          [...input.blocks, ...input.issues].map((offered) => [offered.ref, offered.item]),
        );
        for (const fact of output.facts) {
          const source = byRef.get(fact.from.trim().toUpperCase());
          if (!source) {
            dropped.push(`it named ${fact.from}, which it wasn’t given`);
            continue;
          }
          const code = fact.projectCode?.trim().toUpperCase();
          const project = code ? byCode.get(code) : undefined;
          if (code && !project) {
            dropped.push(`it named ${fact.projectCode}, which is no active Project's code`);
            continue;
          }
          const person = personNamed(fact.person, source, people);
          if (!project && !person) {
            dropped.push('a fact about no Person or Project Commander knows');
            continue;
          }
          const text = cleanFact(fact.text);
          if (!text) continue;
          itemStore.memory.learn({
            kind: 'fact',
            key: factKey(text),
            text,
            confirmed: trustOf(source) === 'trusted',
            personId: person?.id ?? null,
            projectId: project?.id ?? null,
            handles: person?.handles.map((each) => each.handle) ?? [],
            sources: [source.id],
          });
        }
      }
      return { dropped };
    },
  };
}
