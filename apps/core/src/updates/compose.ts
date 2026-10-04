// Putting an Update together (#70): each queued line becomes one or two plain sentences in Ares's
// voice. "Put Updates together" is a Deep job at high thinking, run when the User asks (or when
// they come back, so the Update is ready). If the model is unavailable, over the cap or says
// something unusable, the plain template sentences are used instead, so an Update always works.
//
// Prompt-injection defences (ADR 0004): the prompt is made by the prompt builder. Each line goes
// in a data block of its own: a line about one Item comes from that Item (outside if it arrived
// from a Source), and a line about several is written in Commander's own words with no titles, so
// no block ever mixes outside Items. The reply is checked like any job's: it must fit the schema,
// loses the builder's wording and any URL the model wasn't shown, and its steering flag marks the
// outside Items it names. The model only ever chooses words: what each line is about, and what
// accepting or dismissing it does, stays with the queue. What it wrote is shown with AresText. A busy
// Chat's line is left out here: "Summarise Chat" words it alongside, from the Chat itself (teams.ts).
import type { Item, QueuedLine } from '@commander/domain';
import { prepReadyText, ruleSuggestionText, UPDATE_GROUP_NAMES } from '@commander/domain';
import { type ModelClient, ModelError } from '@commander/models';
import { z } from 'zod';
import { type BuiltPrompt, buildPrompt, type PromptData, PromptRefused } from '../agent/prompt';
import type { InjectionWarningStore } from '../item-store';
import type { KnownSecrets } from '../safety/known-secrets';
import { cleanOutput } from '../safety/output';

export const PUT_UPDATES_TOGETHER = 'put-updates-together';
// At most this many lines go to the model; the rest keep their template sentences.
const MAX_LINES = 40;
const MAX_TEXT = 400;
const TIMEOUT_MS = 45_000;

export const INSTRUCTIONS = `You are Ares, the User's assistant in Commander. You are soft-spoken and calm, you get straight to the point, and you explain things simply, in plain words.

The User has asked for their Update: what you have queued for them since they last asked. Each data block is one line of it; its label starts with the line's reference (E1, E2…) and the group it is in. Write each line again as you would say it to the User: one or two short, plain sentences, in the first person. Keep every name, number, amount and quoted title exactly as it is. Add nothing that isn't in the line: no advice, no greetings, no sign-off, no lists. Never merge, reorder or leave out lines.

Reply with only this JSON object: {"lines":[{"ref":"E1","text":"…"}]}, one entry per line.`;

export const OUTPUT = z.object({
  lines: z
    .array(z.object({ ref: z.string().min(1).max(10), text: z.string().trim().min(1).max(2000) }))
    .max(100),
});
const REPLY = OUTPUT.extend({
  steering: z.array(z.string().max(20)).max(100).optional().catch(undefined),
});

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const money = (usd: number) => `$${usd.toFixed(2)}`;
// One sentence as said: on one line, ending with a full stop (or its own mark).
const sentence = (text: string) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return /[.!?…]$/.test(one) ? one : `${one}.`;
};
// A stuck issue's reason, naming the issue: Ares's sentence usually does already.
const stuckReason = ({ identifier, reason }: { identifier: string; reason: string }) =>
  sentence(reason.includes(identifier) ? reason : `${identifier}: ${reason}`);

/**
 * A queued line in plain words: Ares's template sentence. `quote` puts the Items' titles in; the
 * prompt asks for it only for lines about one Item, so a block never mixes outside Items.
 */
export function templateText(
  line: Pick<QueuedLine, 'about' | 'itemIds'>,
  titleOf: (itemId: string) => string | null,
  { quote = true }: { quote?: boolean } = {},
): string {
  const title = (itemId: string | undefined) => {
    const found = itemId ? titleOf(itemId) : null;
    return found ? `“${found.replace(/\s+/g, ' ').trim()}”` : null;
  };
  const { about } = line;
  switch (about.kind) {
    case 'suggestions': {
      const count = about.proposalIds.length;
      const on = quote && count === 1 ? title(line.itemIds[0]) : null;
      return count === 1
        ? `${about.name}: one suggestion I wasn’t sure about${on ? `, on ${on}` : ''}. It’s waiting for you.`
        : `${about.name}: ${count} suggestions I wasn’t sure about. They’re waiting for you.`;
    }
    case 'chained': {
      const on = quote ? title(line.itemIds[0]) : null;
      const cause = quote ? title(line.itemIds[1]) : null;
      return cause
        ? `${about.name}: ${cause} led me to a suggestion${on ? ` on ${on}` : ''}. It needs your say-so.`
        : `${about.name}: something from outside led me to a suggestion. It needs your say-so.`;
    }
    case 'injection-warnings': {
      const count = line.itemIds.length || about.entryIds.length;
      const which = quote && count === 1 ? title(line.itemIds[0]) : null;
      return which
        ? `${which} held instructions aimed at me. I ignored them.`
        : `${plural(count, 'item')} held instructions aimed at me. I ignored them.`;
    }
    case 'cap-warning': {
      const share = Math.round((about.spentUsd / about.capUsd) * 100);
      return `This month’s model spend is ${money(about.spentUsd)}, ${share}% of your ${money(about.capUsd)} cap. At the cap, my deeper work waits until next month.`;
    }
    case 'autonomy-change':
      return `You’ve accepted my last ${about.accepted} ${about.name} suggestions without changing any. Want me to just do them?`;
    // Linear's words (an assignee's name, a team's, Ares's reason from an issue) only when quoting.
    case 'linear-left': {
      const [only, ...others] = about.issues;
      if (only && !others.length)
        return quote ? sentence(only.why) : 'One of your Linear issues left your list.';
      const count = about.issues.length;
      return about.issues.every((issue) => issue.reassigned)
        ? `${count} of your Linear issues were reassigned.`
        : `${count} of your Linear issues left your list.`;
    }
    case 'linear-stuck': {
      const [only, ...others] = about.issues;
      if (only && !others.length) return quote ? stuckReason(only) : 'One of your Linear issues looks stuck.';
      const count = about.issues.length;
      return quote && about.team.name.trim()
        ? `${count} of your ${about.team.name.replace(/\s+/g, ' ').trim()} issues look stuck.`
        : `${count} of your Linear issues look stuck.`;
    }
    case 'reconnect':
      return about.name
        ? `${about.sourceName} (${about.name}) needs you to sign in again; syncing is paused.`
        : `Your ${about.sourceName} Account needs you to sign in again; syncing is paused.`;
    case 'rule-suggestion':
      return ruleSuggestionText(about);
    // The meeting's title is outside words: only when quoting.
    case 'meeting-prep':
      return prepReadyText(about, { quote });
    // A busy Chat's name only when quoting; Ares's summary replaces this when he can make one.
    case 'chat-summary': {
      const name = quote ? titleOf(about.itemId)?.replace(/\s+/g, ' ').trim() : null;
      return `${name || 'A Teams Chat'}: ${plural(about.count, 'message')} since your last Update.`;
    }
  }
}

export type Composed = {
  // What Ares says about each queued line, by its id.
  texts: Map<number, string>;
  voice: 'ares' | 'template';
};

export type ComposeOptions = {
  client: ModelClient;
  item: (itemId: string) => Item | null;
  secrets?: KnownSecrets;
  injectionWarnings?: Pick<InjectionWarningStore, 'flag'>;
  // Items the steering flag marked, so open views catch up.
  onItemsChanged?: (itemIds: string[]) => void;
  log?: (message: string) => void;
  timeoutMs?: number;
  // Lines worded elsewhere (a busy Chat's summary, made alongside): left out of the prompt, with
  // their plain sentence here.
  apart?: ReadonlySet<number>;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Ares's sentences for these lines (in Update order), or the templates when the model can't help. */
export async function compose(lines: readonly QueuedLine[], options: ComposeOptions): Promise<Composed> {
  const log = options.log ?? ((line: string) => console.warn(line));
  const titleOf = (itemId: string) => options.item(itemId)?.title ?? null;
  const texts = new Map(lines.map((line) => [line.id, templateText(line, titleOf)]));
  const sent = lines.filter((line) => !options.apart?.has(line.id)).slice(0, MAX_LINES);
  if (!sent.length) return { texts, voice: 'template' };

  const data: PromptData[] = sent.map((line, index) => {
    const items = line.itemIds.map(options.item).filter((item): item is Item => item !== null);
    const one = line.itemIds.length === 1 && items.length === 1 ? items[0] : undefined;
    return {
      label: `E${index + 1} · ${UPDATE_GROUP_NAMES[line.group]}`,
      from: one ?? 'user-settings',
      text: templateText(line, titleOf, { quote: !!one }),
    };
  });

  let prompt: BuiltPrompt;
  try {
    prompt = buildPrompt({ instructions: INSTRUCTIONS, data }, { secrets: options.secrets });
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

  markSteering(reply.steering ?? [], prompt, options);
  const cleaned = cleanOutput(reply.lines, prompt.material);
  let wrote = 0;
  const used = new Set<string>();
  for (const { ref, text } of cleaned) {
    const index = /^E(\d+)$/.exec(ref.trim())?.[1];
    const line = index ? sent[Number(index) - 1] : undefined;
    const words = text.replace(/\s+/g, ' ').trim();
    if (!line || used.has(ref) || !words) continue;
    used.add(ref);
    texts.set(line.id, words.length > MAX_TEXT ? `${words.slice(0, MAX_TEXT - 1).trimEnd()}…` : words);
    wrote += 1;
  }
  if (wrote < sent.length) {
    log(`Put Updates together: ${sent.length - wrote} line(s) kept their plain sentence`);
  }
  return { texts, voice: wrote ? 'ares' : 'template' };
}

// The reply's steering flag: each outside Item it names (by its block's ref) gets the warning mark.
function markSteering(named: string[], prompt: BuiltPrompt, options: ComposeOptions) {
  const marked: string[] = [];
  for (const ref of new Set(named)) {
    const itemId = prompt.outside.find((block) => block.ref === ref)?.itemId;
    if (itemId && options.injectionWarnings?.flag(itemId)) marked.push(itemId);
  }
  if (marked.length) options.onItemsChanged?.(marked);
}
