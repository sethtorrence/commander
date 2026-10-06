// Reading Ares's reply as it streams in (#191, #192). Each reply opens with a tag saying what it is,
// which Commander reads in its own code and never shows:
// - [skill]: he wants to use a Skill before answering; the rest of the reply is a JSON object naming
//   it and what to give it (and any steering flag), read once the reply ends, never shown;
// - an answer's grounds: [general] (the model's own knowledge), [their-data] (what his Skills found,
//   or the Conversation so far), [cant] (asked to do what no Skill of his can) or [chat]. On the
//   tag's own line he may add {"steering":[…]}: the outside blocks he took as aimed at him.
// The rest is his text, checked as every model's text is (ADR 0004: the builder's internal wording
// stripped, URLs he wasn't shown removed) before any of it reaches the window.
import { cleanModelText } from '../safety/output';
import { type SteeringFlag, steeringFlag } from '../safety/steering-flag';

// What a reply is, from its opening tag.
export type Grounds = 'general' | 'their-data' | 'cant' | 'chat' | 'skill';

export const GROUNDS_TAGS: Record<Grounds, string> = {
  general: '[general]',
  'their-data': '[their-data]',
  cant: '[cant]',
  chat: '[chat]',
  skill: '[skill]',
};

const TAG = /^\s*\[(general|their-data|cant|chat|skill)\][ \t]*/i;
// Until this much has arrived (or a line ends), a missing tag may still be coming.
const TAG_WINDOW = 24;
// How long the tag's line may run (its steering flag) before it is read as it stands.
const TAG_LINE = 4_000;
// A tag cut off by Stop before it closed.
const PARTIAL_TAG = /^\s*\[[a-z-]{0,12}\]?\s*$/i;

// What he says when asked to do what none of his Skills can: Commander makes sure an answer tagged
// so says it plainly.
export const CANT_DO = 'I can’t do that yet.';
const SAYS_CANT = /can['’]?t (?:do|look)|cannot (?:do|look)|not able to|unable to/i;

export type AnswerReader = {
  add(token: string): void;
  // His answer so far, checked, without the tag (empty while the tag may still be coming, and always
  // for a Skill request). Commander's own lead, when given, comes first.
  text(): string;
  // His whole answer, checked: at the end of the stream, or as far as he got when it stopped.
  final(): string;
  grounds(): Grounds | null;
  // The JSON of a Skill request, as he wrote it (for [skill] only), once the reply has ended.
  request(): string;
  // The outside blocks he flagged as trying to steer him.
  steering(): SteeringFlag;
  // Marked "From Ares's own knowledge": a general answer, or one with no tag.
  ownKnowledge(): boolean;
};

export type ReadOptions = {
  // Commander's own words, said before his (what he couldn't finish, #192).
  lead?: string;
};

export function readAnswer(material: string, options: ReadOptions = {}): AnswerReader {
  let raw = '';
  let grounds: Grounds | null = null;
  let decided = false;
  let body = '';
  let flag: SteeringFlag;

  function decide(ending: boolean) {
    if (decided) return;
    const match = TAG.exec(raw);
    if (match) {
      grounds = (match[1] as string).toLowerCase() as Grounds;
      let rest = raw.slice(match[0].length);
      // Nothing after the tag yet: a steering flag may still be coming on its line.
      if (rest === '' && !ending) return;
      if (grounds === 'skill') {
        decided = true;
        body = rest;
        return;
      }
      // A steering flag on the tag's line: wait for the line to end.
      if (rest.startsWith('{')) {
        const end = rest.indexOf('\n');
        if (end === -1 && !ending && rest.length < TAG_LINE) return;
        const line = end === -1 ? rest : rest.slice(0, end);
        try {
          flag = steeringFlag.parse((JSON.parse(line) as { steering?: unknown }).steering);
          rest = end === -1 ? '' : rest.slice(end + 1);
        } catch {
          // Not a flag after all: his words.
        }
      } else rest = rest.replace(/^\r?\n/, '');
      decided = true;
      body = rest;
      return;
    }
    if (ending || raw.length >= TAG_WINDOW || raw.includes('\n')) {
      decided = true;
      body = ending && PARTIAL_TAG.test(raw) ? '' : raw;
    }
  }

  const clean = (text: string) => cleanModelText(text.replace(/^\s+/, ''), material);
  const led = (text: string) => (options.lead ? (text ? `${options.lead}\n\n${text}` : options.lead) : text);

  return {
    add(token) {
      if (decided) body += token;
      else {
        raw += token;
        decide(false);
      }
    },
    text: () => (!decided ? (options.lead ?? '') : grounds === 'skill' ? '' : led(clean(body))),
    final() {
      decide(true);
      if (grounds === 'skill') return options.lead ?? '';
      const text = clean(body).trimEnd();
      if (grounds === 'cant' && !SAYS_CANT.test(text)) return led(text ? `${CANT_DO} ${text}` : CANT_DO);
      return led(text);
    },
    grounds: () => grounds,
    request: () => (grounds === 'skill' ? body : ''),
    steering: () => flag,
    ownKnowledge: () => decided && (grounds === 'general' || grounds === null),
  };
}

/** The piece that turns what the window holds (`sent`) into `text`: where they part, and the rest. */
export function pieceBetween(sent: string, text: string): { from: number; tokens: string } {
  let from = 0;
  const shorter = Math.min(sent.length, text.length);
  while (from < shorter && sent.charCodeAt(from) === text.charCodeAt(from)) from += 1;
  return { from, tokens: text.slice(from) };
}
