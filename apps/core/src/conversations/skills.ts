// Ares's Skills in a Conversation (#192, decision #24). Each turn he may take up to a few Skill steps
// before answering: he names a Skill and what to give it, Commander runs it through the registry
// (which checks the input against what the Skill needs), and what it found comes back to him for the
// next step or his answer. This file is what the Conversation knows of Skills: which it offers (the
// ones whose result it can hand him), how each result becomes material, how his choice is read, and
// what he says plainly when he couldn't finish. Action Skills (#196) are offered the same way: what
// they hand back is Commander's note on what came of each change, and the proposals, kept on the
// answer and shown under it as cards.
import {
  ACTION_SKILLS,
  type ConversationLink,
  FIND_SKILL,
  type Item,
  LINK_MARKER,
  LINK_REF,
  type SkillInfo,
  type SkillRegistry,
  SUMMARISE_SKILL,
  skillTitle,
  UPDATE_SKILL,
  type UpdateView,
} from '@commander/domain';
import { z } from 'zod';
import type { PromptData } from '../agent/prompt';
import { type SteeringFlag, steeringFlag } from '../safety/steering-flag';
import type { Findings, FoundItem } from '../skills/findings';
import { kindName } from '../skills/read-item';
import { labelOf, sectionOf } from '../updates/kinds/words';

// The most Skill steps one turn takes before he answers.
export const SKILL_STEPS = 3;
// The most Items one answer is handed, however many steps found them.
export const MAX_HANDED = 30;

// The Skills a Conversation can use, in the order he is told of them: those that look, then those
// that act (#196). The rest (Draft) are used where they live until a Conversation can hand him what
// they make.
export const CONVERSATION_SKILLS: readonly string[] = [
  UPDATE_SKILL.name,
  FIND_SKILL.name,
  SUMMARISE_SKILL.name,
  ...ACTION_SKILLS.map((skill) => skill.name),
];

/** The Skills the registry has that a Conversation can use. */
export function offeredSkills(registry: Pick<SkillRegistry, 'list'>): SkillInfo[] {
  const all = registry.list();
  return CONVERSATION_SKILLS.flatMap((name) => all.filter((skill) => skill.name === name));
}

/** What he couldn't finish, said plainly by Commander, before anything he goes on to say. */
export const COULDNT_FINISH = {
  steps:
    'I couldn’t finish all of that: it needed more steps than I take for one message. Ask me for one part at a time.',
  failed: (skill: string) =>
    `I couldn’t finish that: ${skill} didn’t work just now. Ask me again in a moment.`,
} as const;

const choice = z.object({
  skill: z.string().min(1).max(40),
  input: z.unknown().optional(),
  steering: steeringFlag,
});

export type SkillChoice = { skill: string; input: unknown; steering: SteeringFlag };

/** His Skill request, read: the JSON object after [skill], or why it can't be run. */
export function readChoice(
  raw: string,
  offered: readonly SkillInfo[],
): { ok: true; choice: SkillChoice } | { ok: false; why: string } {
  const text = raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let json: unknown;
  try {
    json = JSON.parse(start === -1 || end < start ? text : text.slice(start, end + 1));
  } catch {
    return { ok: false, why: 'it wasn’t a JSON object' };
  }
  const parsed = choice.safeParse(json);
  if (!parsed.success) return { ok: false, why: 'it didn’t name a Skill' };
  const name = parsed.data.skill.trim().toLowerCase();
  if (!offered.some((skill) => skill.name === name)) {
    return { ok: false, why: `there is no Skill called “${name.slice(0, 40)}” to use here` };
  }
  return {
    ok: true,
    choice: { skill: name, input: parsed.data.input ?? {}, steering: parsed.data.steering },
  };
}

/** What the Update Skill gave, as material for his answer, with the Update itself to show. */
export function updateFindings(view: UpdateView | null, item: (itemId: string) => Item | null): Findings {
  if (!view) {
    return {
      note: 'The Update found nothing queued: nothing new since the User last asked.',
      items: [],
      more: [],
      update: null,
    };
  }
  return {
    note: `The Update gave the User their Update, ${view.lines.length} line${view.lines.length === 1 ? '' : 's'}. It is shown to them in full under your answer, each line with its actions, so don’t repeat its lines: lead in with a sentence at most, or answer anything else they asked.`,
    items: [],
    // His own lines, written from outside content: background, with the Items they are about.
    more: view.lines.map((line, index) => ({
      label: `Update line ${index + 1}`,
      from: { background: line.itemIds.flatMap((itemId) => item(itemId) ?? []) },
      text: line.text,
    })),
    update: view,
  };
}

const isFindings = (output: unknown): output is Findings =>
  !!output &&
  typeof output === 'object' &&
  typeof (output as Findings).note === 'string' &&
  Array.isArray((output as Findings).items) &&
  Array.isArray((output as Findings).more);

/** What a Skill run gave, as material for his answer. */
export function findingsOf(skill: string, output: unknown, item: (itemId: string) => Item | null): Findings {
  if (skill === UPDATE_SKILL.name) return updateFindings((output as UpdateView | null) ?? null, item);
  if (isFindings(output)) return output;
  throw new Error(`${skillTitle({ name: skill })} gave nothing a Conversation can use`);
}

/** Everything his Skills found for one answer so far, each Item with the ref his answer links it by. */
export type Gathered = {
  // By ref (I1, I2…), in the order they were found.
  items: Map<string, FoundItem>;
  more: PromptData[];
  notes: string[];
  update: UpdateView | null | undefined;
  skills: string[];
  // What his action Skills handed the gate, by proposal, in order (#196).
  proposalIds: number[];
};

export const nothingGathered = (): Gathered => ({
  items: new Map(),
  more: [],
  notes: [],
  update: undefined,
  skills: [],
  proposalIds: [],
});

/** The Items handed out for this answer so far, by ref: what an action Skill may name. */
export const handedRefs = (gathered: Gathered): Map<string, string> =>
  new Map([...gathered.items].map(([ref, { item }]) => [ref, item.id]));

/** Adds what a Skill found, giving each Item not handed out before the next ref. */
export function gather(into: Gathered, skill: string, findings: Findings): void {
  into.skills.push(skill);
  into.notes.push(findings.note);
  const handed = new Set([...into.items.values()].map(({ item }) => item.id));
  for (const found of findings.items) {
    if (handed.has(found.item.id) || into.items.size >= MAX_HANDED) continue;
    handed.add(found.item.id);
    into.items.set(`I${into.items.size + 1}`, found);
  }
  into.more.push(...findings.more);
  if (findings.update !== undefined) into.update = findings.update;
  for (const proposalId of findings.proposalIds ?? [])
    if (!into.proposalIds.includes(proposalId)) into.proposalIds.push(proposalId);
}

export const gatheredAnything = (gathered: Gathered) =>
  gathered.items.size > 0 ||
  gathered.more.length > 0 ||
  gathered.update !== undefined ||
  gathered.proposalIds.length > 0;

/**
 * The material for his next step or answer: Commander's notes on what each Skill did (Commander's
 * own words), each Item in a block of its own with its ref (its trust from where it came from), then
 * the rest (what Ares knows, People, past Updates, the Update's lines).
 */
export function materialOf(gathered: Gathered): PromptData[] {
  if (!gathered.notes.length) return [];
  return [
    {
      label: 'What your Skills did',
      from: 'user-settings',
      text: gathered.notes.map((note) => `- ${note}`).join('\n'),
    },
    ...[...gathered.items].map(([ref, { item, text }]) => ({
      label: `${ref} · ${kindName(item)} · ${item.title}`,
      from: item,
      text,
      ref,
    })),
    ...gathered.more,
  ];
}

/** An Item as an answer's link shows it. */
export function linkTo(ref: string, item: Item): ConversationLink {
  return {
    ref,
    itemId: item.id,
    kind: item.kind,
    title: item.title,
    label: labelOf(item),
    section: sectionOf(item),
  };
}

/** Every Item handed out for this answer, as links (while he writes, so his refs show as links at once). */
export const handedLinks = (gathered: Gathered): ConversationLink[] =>
  [...gathered.items].map(([ref, { item }]) => linkTo(ref, item));

/**
 * His answer's links: the refs it names that were handed out for it, in the order it names them. Any
 * other ref is taken out of the text, so a link never points anywhere he wasn't shown.
 */
export function linksIn(text: string, gathered: Gathered): { text: string; links: ConversationLink[] } {
  const links: ConversationLink[] = [];
  // A marker that goes takes the space before it too.
  const kept = text.replace(new RegExp(`[ \\t]?${LINK_MARKER.source}`, 'g'), (marker, ref: string) => {
    const found = LINK_REF.test(ref) ? gathered.items.get(ref) : undefined;
    if (!found) return '';
    if (!links.some((link) => link.ref === ref)) links.push(linkTo(ref, found.item));
    return marker;
  });
  return { text: kept, links };
}
