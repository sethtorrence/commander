// Putting an Update together (#70, #186): each queued line becomes one or two plain sentences in
// Ares's voice that say what it is (named, with where it lives), what happened, why it matters and
// what to do. "Put Updates together" is a Deep job at high thinking, run when the User asks (or when
// they come back, so the Update is ready).
//
// - Every kind of line has a plain sentence (kinds/), made from its Items' own data, which already
//   answers all four. That is what the User sees when the model is unavailable, over the cap or
//   says something unusable, so an Update always works and always says what, why and what to do.
// - The model only makes the sentences read better. It is handed each line's facts, in Commander's
//   own words, and each of its Items (title, Source, where it stands, dates, people) in a data block
//   of its own, and the prompt's guidance for each kind of line present, with a good and a bad
//   example. Every line it writes is checked against what it was handed (grounding.ts): a line with
//   a name, number, date or quoted title it wasn't given, or one that doesn't say what it is about,
//   keeps its plain sentence. Nothing it says is invented.
//
// Prompt-injection defences (ADR 0004): the prompt is made by the prompt builder, each outside Item
// in its own data block. The reply is checked like any job's: it must fit the schema, loses the
// builder's wording and any URL the model wasn't shown, and its steering flag marks an outside Item
// only with a quote found in it. The model only ever chooses words: what each line is about, and what
// accepting or dismissing it does, stays with the queue. What it wrote is shown with AresText. Lines
// kept apart (kinds/: a busy Chat, worded from the Chat itself in teams.ts; the GitHub summary, whose
// "nothing on fire" is Commander's to say) aren't sent.
import type { Item, ItemKind, QueuedLine } from '@commander/domain';
import { UPDATE_GROUP_NAMES } from '@commander/domain';
import { type ModelClient, ModelError } from '@commander/models';
import { z } from 'zod';
import { type BuiltPrompt, buildPrompt, type PromptData, PromptRefused } from '../agent/prompt';
import type { InjectionWarningStore } from '../item-store';
import type { KnownSecrets } from '../safety/known-secrets';
import { cleanOutput } from '../safety/output';
import { heedSteering, steeringFlag } from '../safety/steering-flag';
import { checkGrounded } from './grounding';
import {
  guidanceFor,
  isApart,
  kindName,
  type LineContext,
  labelOf,
  lineFacts,
  lineTemplate,
  nameOf,
  rowFacts,
  whereOf,
} from './kinds';

export const PUT_UPDATES_TOGETHER = 'put-updates-together';
// At most this many lines go to the model; the rest keep their plain sentences.
const MAX_LINES = 40;
// At most this many of a line's Items get a block of their own; the rest are counted.
const MAX_ITEMS = 8;
const TIMEOUT_MS = 45_000;

const VOICE =
  'You are Ares, the User’s assistant in Commander. You are soft-spoken and calm, you get straight to the point, and you explain things simply, as if to someone with no context: plain words, no jargon.';

const RULES = `The User has asked for their Update: what you have queued for them since they last asked. Each line has a data block of its own, labelled with its reference (E1, E2…), its group and what it is about, holding what Commander knows of it. The Items a line is about each have a block of their own, labelled with the line's reference and a number (E2.1, E2.2…).

Write each line as you would say it to the User. Every line answers four things:
1. What it is: name it, with where it lives (ENG-418 “Throttle bursts on /sync” in Linear). For several Items, say how many and name up to three.
2. What happened.
3. Why it matters to the User, in a few words.
4. What to do next, or plainly "Nothing to do".

Keep it short: one or two sentences, under 45 words, in the first person. Be specific and plain: no hedging ("it seems", "you may want to"), no jargon, no greetings or sign-off, no lists.
Use only what the blocks say. Every name, number, date and quoted title must be exactly as a block gives it. Never invent an Item, a person, a number, a date or a reason; when you aren't sure, say less.
Write every line, in order. Never merge lines or leave one out.`;

/** The instructions for these kinds of line: Ares's voice, the four questions, and each kind's guidance. */
export function instructionsFor(lines: readonly Pick<QueuedLine, 'about'>[]): string {
  const guidance = guidanceFor(lines.map((line) => line.about.kind));
  return `${VOICE}

${RULES}

How to write each kind of line (the examples' names are made up):

${guidance}

Reply with only this JSON object: {"lines":[{"ref":"E1","text":"…"}]}, one entry per line.`;
}

export const OUTPUT = z.object({
  lines: z
    .array(z.object({ ref: z.string().min(1).max(10), text: z.string().trim().min(1).max(2000) }))
    .max(100),
});
const REPLY = OUTPUT.extend({ steering: steeringFlag });

const KIND_NOUNS: Partial<Record<ItemKind, string>> = {
  'linear-issue': 'Linear issue',
  email: 'email',
  event: 'calendar event',
  'pull-request': 'pull request',
  'review-request': 'review request',
  'github-issue': 'GitHub issue',
  'github-release': 'GitHub release',
  chat: 'Teams Chat',
  'channel-post': 'Teams channel post',
  todo: 'Todo',
  block: 'line of the User’s notes',
  'daily-note': 'Daily Note',
  'meeting-prep': 'meeting prep',
  'github-summary': 'GitHub summary',
};

export type Composed = {
  // What Ares says about each queued line, by its id.
  texts: Map<number, string>;
  voice: 'ares' | 'template';
};

export type ComposeOptions = {
  client: ModelClient;
  context: LineContext;
  secrets?: KnownSecrets;
  injectionWarnings?: Pick<InjectionWarningStore, 'flag'>;
  // Items the steering flag marked, so open views catch up.
  onItemsChanged?: (itemIds: string[]) => void;
  log?: (message: string) => void;
  timeoutMs?: number;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// What one line hands the model: its blocks, and what its sentence may rest on.
type Handed = { line: QueuedLine; ref: string; data: PromptData[]; handed: string; mustName: string[] };

function hand(line: QueuedLine, ref: string, context: LineContext): Handed {
  const items = line.itemIds
    .map((itemId) => context.item(itemId))
    .filter((item): item is Item => item !== null)
    .slice(0, MAX_ITEMS);
  const facts = lineFacts(line, context);
  const more = line.itemIds.length - items.length;
  const lineBlock: PromptData = {
    label: `${ref} · ${UPDATE_GROUP_NAMES[line.group]} · ${kindName(line.about)}`,
    from: 'user-settings',
    text: [
      ...facts,
      items.length
        ? `Its Items are in the blocks labelled ${ref}.1${items.length > 1 ? ` to ${ref}.${items.length}` : ''}.${more > 0 ? ` (${more} more not shown.)` : ''}`
        : 'It is about no Item in particular.',
    ].join('\n'),
  };
  const itemBlocks: PromptData[] = items.map((item, index) => {
    const row = rowFacts(line, item.id, context);
    return {
      label: `${ref}.${index + 1} · Item of ${ref}`,
      from: item,
      text: [
        `Item: ${nameOf(item)}`,
        `Kind: ${KIND_NOUNS[item.kind] ?? item.kind}`,
        `Where: ${whereOf(item)}`,
        ...(row ? [`Where it stands: ${row.state}`, ...(row.more ?? [])] : []),
      ].join('\n'),
    };
  });
  const data = [lineBlock, ...itemBlocks];
  const [only] = items;
  const mustName =
    items.length === 1 && only
      ? [labelOf(only) ?? '', only.title.replace(/\s+/g, ' ').trim()]
      : items.length > 1
        ? [
            ...items.flatMap((item) => [labelOf(item) ?? '', item.title.replace(/\s+/g, ' ').trim()]),
            ...(facts.join(' ').match(/\d+/g) ?? []),
          ]
        : [];
  const handed = [...data.map((part) => part.text), lineTemplate(line, context)].join('\n');
  return { line, ref, data, handed, mustName: mustName.filter(Boolean) };
}

/** Ares's sentences for these lines (in Update order), or the plain sentences where the model can't help. */
export async function compose(lines: readonly QueuedLine[], options: ComposeOptions): Promise<Composed> {
  const log = options.log ?? ((line: string) => console.warn(line));
  const { context } = options;
  const texts = new Map(lines.map((line) => [line.id, lineTemplate(line, context)]));
  const sent = lines.filter((line) => !isApart(line.about)).slice(0, MAX_LINES);
  if (!sent.length) return { texts, voice: 'template' };

  const handed = sent.map((line, index) => hand(line, `E${index + 1}`, context));
  let prompt: BuiltPrompt;
  try {
    prompt = buildPrompt(
      { instructions: instructionsFor(sent), data: handed.flatMap((each) => each.data) },
      { secrets: options.secrets },
    );
  } catch (error) {
    if (!(error instanceof PromptRefused)) throw error;
    log(`Put Updates together: ${error.message}`);
    return { texts, voice: 'template' };
  }

  let reply: z.infer<typeof REPLY>;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  try {
    const answer = await options.client.complete({
      tier: 'deep',
      job: PUT_UPDATES_TOGETHER,
      reasoningEffort: 'high',
      messages: prompt.messages,
      schema: REPLY,
      signal: controller.signal,
    });
    reply = answer.json;
  } catch (error) {
    const kind = error instanceof ModelError ? error.kind : 'failed';
    log(`Put Updates together used the plain sentences (${kind}): ${message(error)}`);
    return { texts, voice: 'template' };
  } finally {
    clearTimeout(timer);
  }

  const marked = heedSteering(reply.steering, prompt, options.injectionWarnings);
  if (marked.length) options.onItemsChanged?.(marked);
  const cleaned = cleanOutput(reply.lines, prompt.material);
  let wrote = 0;
  const kept: string[] = [];
  const used = new Set<string>();
  for (const { ref, text } of cleaned) {
    const each = handed.find((one) => one.ref === ref.trim());
    const words = text.replace(/\s+/g, ' ').trim();
    if (!each || used.has(each.ref) || !words) continue;
    used.add(each.ref);
    const grounded = checkGrounded(words, each.handed, { mustName: each.mustName });
    if (!grounded.ok) {
      kept.push(`${each.ref} (${grounded.why})`);
      continue;
    }
    texts.set(each.line.id, words);
    wrote += 1;
  }
  if (kept.length)
    log(`Put Updates together: plain sentences kept where Ares’s didn’t check out: ${kept.join(', ')}`);
  if (wrote + kept.length < sent.length) {
    log(`Put Updates together: ${sent.length - wrote - kept.length} line(s) kept their plain sentence`);
  }
  return { texts, voice: wrote ? 'ares' : 'template' };
}
