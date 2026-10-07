// What the User tells Ares in a Conversation becomes Memory (#194, decisions #24, #19; ADR 0006 and
// ADR 0004's fifth amendment: writing Memory needs no gate). When the User states a fact or a
// preference about themselves, their work or the people in it ("I don't take meetings before 10",
// "Leo is our Acme contact"), Ares keeps it as a confirmed memory written by the User, with their
// turn as its source, under the same key as a fact from their Daily Notes (agent/learn-facts.ts), so
// the two meet in one memory. "Forget that" and "Actually Leo moved to Globex" forget or change what
// he holds. Each change becomes a line under his answer, in Commander's own words, with Undo.
//
// Only the User's own words become confirmed Memory, never what an Item in the Conversation says:
// - A call of its own (Quick, low thinking) reads the User's latest message, their earlier ones in
//   this Conversation for context, their Projects and what Ares already knows that may be relevant.
//   Nothing from an Item is in it: not the Item a Conversation is about, not what his Skills found,
//   not his own answers (which may repeat what an email said).
// - What it keeps must rest on the User's words: every name and number in it must be one they wrote
//   in this Conversation (`ungrounded`), or it is dropped. That holds even for a memory he picked up
//   from outside content, handed in as background so a correction can name it: its words can't ride
//   into a confirmed memory unless the User wrote them.
// - Forgetting needs the User to have asked for it in their latest message (`asksToForget`), and only
//   reaches memories handed to the call, a few at most, each with Undo.
import type { Item, Person, Project, Remembered } from '@commander/domain';
import type { ModelClient } from '@commander/models';
import { z } from 'zod';
import { cleanFact, factKey, personNamed } from '../agent/learn-facts';
import { buildPrompt, type PromptData } from '../agent/prompt';
import type { MemoryStore, RecalledMemory, TurnSource } from '../item-store';
import type { KnownSecrets } from '../safety/known-secrets';
import { cleanModelText } from '../safety/output';

// The usage ledger's name for these calls (AGENT_JOB_NAMES: "Remember what you tell Ares").
export const REMEMBER_JOB = 'remember-from-conversations';

// The most memories handed in, the most earlier messages read for context, and the most changes one
// message makes.
const MEMORIES_HANDED = 10;
const EARLIER = 6;
const MAX_EARLIER = 600;
const MAX_CHANGES = 5;
const MAX_SAID = 200;

const INSTRUCTIONS = `You are Ares. The User is talking with you in a Conversation, and you keep what they tell you about themselves, their work and the people in it, to remember it later.

The data holds the User's latest message, their earlier messages in this Conversation (only to make sense of the latest), the User's Projects (each with its code), and what you already know that may be relevant, each memory marked with a reference ([M1], [M2]…).

From the User's latest message only:
- remember: each lasting fact or preference the User states themselves about themselves, their work or the people in it ("I don't take meetings before 10", "Leo is our Acme contact"). Not questions, requests, tasks, to-dos or passing remarks, and nothing they only ask you to look at or find. A preference is how the User likes things done; anything else that lasts is a fact. When it corrects or updates something you know, name that memory in "replaces".
- forget: the memories the User asks you to forget, or says are wrong or no longer true without saying what is true now.
Most messages state nothing to keep: then both lists are empty.

Reply with only this JSON object: {"remember":[{"kind":"preference","text":"…","said":"…","person":"…","projectCode":"…","replaces":"M1"}],"forget":["M2"]}
- kind: "fact" or "preference".
- text: what to keep, in one short plain sentence about the User in the third person ("The User doesn't take meetings before 10", "Leo is the User's contact at Acme"), with the User's own names and numbers. No full stop.
- said: the same words addressed to the User, to follow "I'll remember that" ("you don't take meetings before 10", "Leo is your contact at Acme"). No full stop.
- person: the name of the person it is about, as the User wrote it, when it is about someone; otherwise leave it out.
- projectCode: the code of the Project it is about, exactly as listed, when it is about one; otherwise leave it out.
- replaces: the reference of the memory it corrects, when it corrects one; otherwise leave it out.`;

const ref = z.string().trim().max(10);

export const OUTPUT = z.object({
  remember: z
    .array(
      z.object({
        kind: z.enum(['fact', 'preference']).catch('fact'),
        text: z.string().trim().min(1).max(400),
        said: z.string().trim().max(400).nullish(),
        person: z.string().trim().max(120).nullish(),
        projectCode: z.string().trim().max(20).nullish(),
        replaces: ref.nullish(),
      }),
    )
    .max(10)
    .default([]),
  forget: z.array(ref).max(10).default([]),
});

// Words, as both sides are compared: runs of letters, and runs of digits ("10am" is 10 and am).
const PIECE = /\p{L}+|\p{N}+/gu;
const piecesOf = (text: string) => (text.match(PIECE) ?? []).map((piece) => piece.toLowerCase());

// Capitalised words a sentence about the User may open with or hold that name nobody.
const PLAIN = new Set(
  (
    'the a an user users user’s i you your yours he she they them his her their it its we our us this that these ' +
    'those there here ares commander when what who whom where why how if in on at for to of by with from and or ' +
    'but not no never always only every each all some any as after before until since during prefers prefer ' +
    'likes like wants want does doesn don isn is are was were be has have had takes take works work'
  ).split(' '),
);

// How much of a word two forms of it share ("prefers" and "prefer").
const STEM = 4;
const stem = (word: string) => word.slice(0, STEM);

/**
 * The names and numbers in what is to be kept that the User never wrote (in `theirs`, their own
 * messages): a number must be one of theirs; a capitalised word must share its start with one of
 * theirs, unless it is a plain word that names nobody. Empty when it rests on the User's words.
 */
export function ungrounded(text: string, theirs: string): string[] {
  const words = piecesOf(theirs);
  const exact = new Set(words);
  const stems = new Set(words.map(stem));
  const missing: string[] = [];
  for (const piece of text.match(PIECE) ?? []) {
    const lower = piece.toLowerCase();
    if (/^\p{N}+$/u.test(piece)) {
      if (!exact.has(lower)) missing.push(piece);
    } else if (/^\p{Lu}/u.test(piece) && !PLAIN.has(lower)) {
      if (!exact.has(lower) && !stems.has(stem(lower))) missing.push(piece);
    }
  }
  return missing;
}

const FORGET =
  /\b(?:forget|forgot|delete|remove|erase|drop|scratch|disregard|ignore|wrong|incorrect|untrue|not true|not right|not so|no longer|any ?more|never mind|take (?:it|that) back)\b/i;

/** Whether the User's message asks Ares to forget something, or says what he holds isn't so. */
export const asksToForget = (said: string): boolean => FORGET.test(said);

// A sentence as a line holds it: one line, no closing full stop.
const sentence = (text: string, max = MAX_SAID) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return (one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one).replace(/[.。]+$/, '');
};

/** The lines under his answer, in Commander's own words around the User's. */
export const REMEMBERED_LINES = {
  learned: (said: string) => `I’ll remember that ${said}.`,
  learnedAs: (text: string) => `I’ll remember this: ${text}.`,
  changed: (was: string, said: string) => `I had “${was}”. Now I’ll remember that ${said}.`,
  changedAs: (was: string, text: string) => `I had “${was}”. Now I’ll remember this: ${text}.`,
  forgot: (text: string) => `I’ve forgotten “${text}”.`,
} as const;

export type RememberRequest = TurnSource & {
  // The User's message being answered, and their earlier messages in this Conversation, oldest first.
  said: string;
  earlier: readonly string[];
  // Memories earlier answers in this Conversation learned or changed: "forget that" may mean one.
  heldHere: readonly string[];
  signal?: AbortSignal;
};

export type RememberOptions = {
  client: ModelClient;
  // Memory, through the Item store (each change in a transaction of its own).
  memory: Pick<MemoryStore, 'lookup' | 'get' | 'tell' | 'correct' | 'forget' | 'undoTurn'>;
  projects: () => Project[];
  people: () => Person[];
  // Items by id: the outside Items an unconfirmed memory came from, for its background block.
  item: (itemId: string) => Item | null;
  secrets?: KnownSecrets;
  log?: (message: string) => void;
};

export type Rememberer = {
  // Learns from the User's message: what changed, as the lines under his answer. Never throws for
  // what the model said; a failed call throws, and learns nothing.
  learn(request: RememberRequest): Promise<Remembered[]>;
  // Undo on one of those lines.
  undo(memoryId: string, turn: TurnSource): void;
};

export function createRememberer(options: RememberOptions): Rememberer {
  const log = options.log ?? ((line: string) => console.warn(line));

  // What Ares knows that the message may be about, and what this Conversation changed, each with a ref.
  function handed(request: RememberRequest): Map<string, RecalledMemory> {
    const found = new Map<string, RecalledMemory>();
    const lookedUp = options.memory.lookup({
      text: request.said,
      kinds: ['fact', 'preference'],
      limit: MEMORIES_HANDED,
    });
    const here = request.heldHere.flatMap((memoryId) => {
      const memory = options.memory.get(memoryId);
      return memory && memory.kind !== 'rule' ? [{ ...memory, foundBy: [] }] : [];
    });
    for (const memory of [...here, ...lookedUp]) {
      if ([...found.values()].some((each) => each.id === memory.id)) continue;
      if (found.size >= MEMORIES_HANDED + here.length) break;
      found.set(`M${found.size + 1}`, memory);
    }
    return found;
  }

  function prompt(request: RememberRequest, memories: Map<string, RecalledMemory>): PromptData[] {
    const projects = options.projects();
    const line = ([key, memory]: [string, RecalledMemory]) => `[${key}] (${memory.kind}) ${memory.text}`;
    const confirmed = [...memories].filter(([, memory]) => memory.confirmed);
    const unconfirmed = [...memories].filter(([, memory]) => !memory.confirmed);
    const data: PromptData[] = [
      { label: 'The User’s latest message', from: 'user-settings', text: request.said },
    ];
    const earlier = request.earlier.slice(-EARLIER);
    if (earlier.length) {
      data.push({
        label: 'The User’s earlier messages in this Conversation',
        from: 'user-settings',
        text: earlier.map((text) => `- ${sentence(text, MAX_EARLIER)}`).join('\n'),
      });
    }
    data.push({
      label: 'Projects',
      from: 'user-settings',
      text: projects.length
        ? projects.map((project) => `${project.code} · ${project.name}`).join('\n')
        : 'The User has no Projects yet.',
    });
    if (confirmed.length) {
      data.push({ label: 'What Ares knows', from: 'user-settings', text: confirmed.map(line).join('\n') });
    }
    if (unconfirmed.length) {
      const sources = unconfirmed.flatMap(([, memory]) =>
        memory.sources.flatMap((source) => options.item(source.itemId) ?? []),
      );
      data.push({
        label: 'What Ares has picked up (unconfirmed)',
        from: { background: [...new Map(sources.map((item) => [item.id, item])).values()] },
        text: unconfirmed.map(line).join('\n'),
      });
    }
    return data;
  }

  return {
    async learn(request) {
      const memories = handed(request);
      const built = buildPrompt(
        { instructions: INSTRUCTIONS, data: prompt(request, memories) },
        { secrets: options.secrets },
      );
      const answer = await options.client.complete({
        tier: 'quick',
        job: REMEMBER_JOB,
        reasoningEffort: 'low',
        messages: built.messages,
        schema: OUTPUT,
        ...(request.signal && { signal: request.signal }),
      });
      if (request.signal?.aborted) return [];
      const reply = answer.json;
      // Everything the User wrote in this Conversation: what is kept must rest on it.
      const theirs = [...request.earlier, request.said].join('\n');
      const byCode = new Map(options.projects().map((project) => [project.code.toUpperCase(), project]));
      const people = options.people();
      const turn: TurnSource = { conversationId: request.conversationId, turnId: request.turnId };
      const lines: Remembered[] = [];
      const touched = new Set<string>();
      const said = (raw: string | null | undefined) => {
        const text = raw ? sentence(cleanModelText(raw, built.material)) : '';
        return text && !ungrounded(text, theirs).length ? text : null;
      };

      for (const wanted of reply.remember) {
        if (lines.length >= MAX_CHANGES) break;
        const text = cleanFact(cleanModelText(wanted.text, built.material));
        if (!text) continue;
        const missing = ungrounded(text, theirs);
        if (missing.length) {
          log(
            `Ares didn’t keep a memory from a Conversation: it named ${missing.join(', ')}, which the User didn’t write`,
          );
          continue;
        }
        const words = said(wanted.said);
        const replaced = wanted.replaces ? memories.get(wanted.replaces.toUpperCase()) : undefined;
        try {
          if (replaced && !touched.has(replaced.id)) {
            options.memory.correct(replaced.id, text, turn);
            touched.add(replaced.id);
            lines.push({
              memoryId: replaced.id,
              did: 'changed',
              line: words
                ? REMEMBERED_LINES.changed(sentence(replaced.text), words)
                : REMEMBERED_LINES.changedAs(sentence(replaced.text), text),
              undone: false,
            });
            continue;
          }
          const person = personNamed(wanted.person ?? undefined, null, people);
          const project = wanted.projectCode ? byCode.get(wanted.projectCode.toUpperCase()) : undefined;
          const memory = options.memory.tell(
            {
              kind: wanted.kind,
              text,
              key: factKey(text, wanted.kind),
              confirmed: true,
              by: 'user',
              personId: person?.id ?? null,
              projectId: project?.id ?? null,
              handles: person?.handles.map((each) => each.handle) ?? [],
              sources: [],
            },
            turn,
          );
          if (!memory || touched.has(memory.id)) continue;
          touched.add(memory.id);
          lines.push({
            memoryId: memory.id,
            did: 'learned',
            line: words ? REMEMBERED_LINES.learned(words) : REMEMBERED_LINES.learnedAs(text),
            undone: false,
          });
        } catch (error) {
          log(
            `Ares couldn’t keep a memory from a Conversation: ${error instanceof Error ? error.message : error}`,
          );
        }
      }

      if (reply.forget.length && asksToForget(request.said)) {
        for (const wanted of reply.forget) {
          if (lines.length >= MAX_CHANGES) break;
          const memory = memories.get(wanted.toUpperCase());
          if (!memory || touched.has(memory.id)) continue;
          try {
            options.memory.forget(memory.id, turn);
            touched.add(memory.id);
            lines.push({
              memoryId: memory.id,
              did: 'forgot',
              line: REMEMBERED_LINES.forgot(sentence(memory.text)),
              undone: false,
            });
          } catch (error) {
            log(`Ares couldn’t forget a memory: ${error instanceof Error ? error.message : error}`);
          }
        }
      }
      return lines;
    },

    undo(memoryId, turn) {
      options.memory.undoTurn(memoryId, turn);
    },
  };
}
