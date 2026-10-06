// Reading Ares's answer as it streams in (#191). Each answer opens with a tag saying what it rests
// on, which Commander reads in its own code and never shows; the rest is his text, checked as every
// model's text is (ADR 0004: the builder's internal wording stripped, URLs he wasn't shown removed)
// before any of it reaches the window.
import { cleanModelText } from '../safety/output';

// What an answer rests on, from its opening tag.
export type Grounds = 'general' | 'their-data' | 'chat';

export const GROUNDS_TAGS: Record<Grounds, string> = {
  general: '[general]',
  'their-data': '[their-data]',
  chat: '[chat]',
};

const TAG = /^\s*\[(general|their-data|chat)\][ \t]*\n?/i;
// Until this much has arrived (or a line ends), a missing tag may still be coming.
const TAG_WINDOW = 24;
// A tag cut off by Stop before it closed.
const PARTIAL_TAG = /^\s*\[[a-z-]{0,12}\]?\s*$/i;

// What he says when asked about the User's data, which he can't look up yet: Commander makes sure an
// answer tagged so says it plainly.
export const CANT_LOOK_UP = 'I can’t look that up yet.';
const SAYS_CANT_LOOK_UP = /can['’]?t look (?:that|this|it) up yet|cannot look (?:that|this|it) up yet/i;

export type AnswerReader = {
  add(token: string): void;
  // His answer so far, checked, without the tag (empty while the tag may still be coming).
  text(): string;
  // His whole answer, checked: at the end of the stream, or as far as he got when it stopped.
  final(): string;
  grounds(): Grounds | null;
  // Marked "From Ares's own knowledge": a general answer, or one with no tag (in this ticket nothing
  // he says can rest on the User's data, so marking it is never wrong).
  ownKnowledge(): boolean;
};

export function readAnswer(material: string): AnswerReader {
  let raw = '';
  let grounds: Grounds | null = null;
  let decided = false;
  let body = '';

  function decide(ending: boolean) {
    if (decided) return;
    const match = TAG.exec(raw);
    if (match) {
      grounds = (match[1] as string).toLowerCase() as Grounds;
      decided = true;
      body = raw.slice(match[0].length);
      return;
    }
    if (ending || raw.length >= TAG_WINDOW || raw.includes('\n')) {
      decided = true;
      body = ending && PARTIAL_TAG.test(raw) ? '' : raw;
    }
  }

  const clean = (text: string) => cleanModelText(text.replace(/^\s+/, ''), material);

  return {
    add(token) {
      if (decided) body += token;
      else {
        raw += token;
        decide(false);
      }
    },
    text: () => (decided ? clean(body) : ''),
    final() {
      decide(true);
      const text = clean(body).trimEnd();
      if (grounds === 'their-data' && !SAYS_CANT_LOOK_UP.test(text)) {
        return text ? `${CANT_LOOK_UP} ${text}` : CANT_LOOK_UP;
      }
      return text;
    },
    grounds: () => grounds,
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
