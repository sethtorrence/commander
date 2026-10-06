// Ares's Update lines are checked against what he was handed (#186, ADR 0004): every name, number,
// date and quoted title in a line he wrote must be one the line's data blocks held. A line that
// doesn't check out is dropped and the plain sentence shown instead, so nothing he says is invented.
//
// The check is deliberately strict and simple. It reads the line for:
// - numbers (digits, amounts, percentages, times, and number words from two to twenty);
// - identifiers (ENG-418, acme/api#12, #12) and quoted text (“…”);
// - capitalised words that aren't ordinary sentence openings (names of people, teams, months, days)
//   and words for days (today, tomorrow, yesterday);
// and each must be found in what was handed. It also asks that the line names what it is about and
// stays short. What no check can catch (a plausible sentence with no name or number in it) is still
// only text, shown through AresText and marked as Ares's.

export type Grounding = { ok: true } | { ok: false; why: string };

export type GroundingOptions = {
  // The line must name what it is about: at least one of these (an identifier, a title, a count).
  mustName?: readonly string[];
};

// A short line: at most this many characters and sentences.
export const MAX_LINE = 320;
const MAX_SENTENCES = 3;

const NUMBER = /\$?\d+(?:[.,:]\d+)*%?/g;
const NUMBER_WORDS: Record<string, string> = {
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  twenty: '20',
  dozen: '12',
};
const IDENTIFIER = /\b[A-Za-z][A-Za-z0-9]{0,9}-\d+\b|[\w.-]+\/[\w.-]+#\d+|#\d+/g;
const QUOTED = /“([^”]{2,})”|"([^"]{2,})"|‘([^’]{3,})’/g;
const DAY_WORDS = /\b(?:today|tomorrow|yesterday|tonight|this morning|this afternoon|this evening)\b/gi;
// A word starting with a capital letter (letters, digits, apostrophes and hyphens inside).
const CAPITALISED = /\p{Lu}[\p{L}\p{N}’'-]*/gu;

// Commander's own words, which any line may use.
const VOCABULARY = new Set(
  [
    'ares',
    'commander',
    'update',
    'updates',
    'todo',
    'todos',
    'dashboard',
    'notes',
    'linear',
    'email',
    'calendar',
    'github',
    'teams',
    'gmail',
    'outlook',
    'google',
    'settings',
    'account',
    'accounts',
    'section',
    'project',
    'projects',
    'rule',
    'rules',
    'daily',
    'note',
    'chat',
    'chats',
    'accept',
    'dismiss',
    'open',
    'reply',
    'tick',
    'done',
    'snooze',
    'not',
    'an',
    'instruction',
    'yes',
    'auto',
    'ask',
    'off',
    'i',
    'i’m',
    "i'm",
    'i’ll',
    "i'll",
    'i’ve',
    "i've",
    'i’d',
    "i'd",
    'ok',
  ].map((word) => word.toLowerCase()),
);

// Ordinary words a sentence may open with, including the plain imperatives of what to do.
const OPENINGS = new Set([
  'a',
  'about',
  'after',
  'again',
  'already',
  'check',
  'choose',
  'give',
  'go',
  'keep',
  'leave',
  'make',
  'read',
  'see',
  'sign',
  'take',
  'unless',
  'all',
  'also',
  'an',
  'and',
  'another',
  'any',
  'anything',
  'as',
  'at',
  'because',
  'before',
  'both',
  'but',
  'by',
  'each',
  'either',
  'every',
  'everything',
  'for',
  'from',
  'have',
  'he',
  'her',
  'here',
  'his',
  'if',
  'in',
  'it',
  'it’s',
  "it's",
  'its',
  'just',
  'last',
  'let',
  'look',
  'many',
  'more',
  'most',
  'my',
  'neither',
  'new',
  'no',
  'none',
  'nobody',
  'nothing',
  'now',
  'of',
  'on',
  'once',
  'one',
  'only',
  'or',
  'other',
  'please',
  'say',
  'she',
  'since',
  'so',
  'some',
  'someone',
  'something',
  'still',
  'that',
  'that’s',
  "that's",
  'the',
  'their',
  'them',
  'then',
  'there',
  'there’s',
  "there's",
  'these',
  'they',
  'they’re',
  "they're",
  'this',
  'those',
  'to',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'until',
  'we',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'why',
  'with',
  'without',
  'worth',
  'you',
  'you’ve',
  "you've",
  'you’re',
  "you're",
  'your',
]);

const fold = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
const numberOf = (token: string) => token.replace(/[$%]/g, '').replace(/,(?=\d{3}\b)/g, '');
const wordsOf = (text: string) => {
  const words = fold(text).match(/[\p{L}\p{N}'-]+/gu) ?? [];
  return new Set([...words, ...words.flatMap((word) => word.split('-'))]);
};

// Where each sentence starts in the text, so a capitalised opening isn't taken for a name.
function sentenceStarts(text: string): Set<number> {
  const starts = new Set<number>();
  for (const match of text.matchAll(/(?:^|[.!?:;—]\s+|\(\s*)(?=[“"‘(]?\p{Lu})/gu)) {
    const at = (match.index ?? 0) + match[0].length;
    starts.add(/[“"‘(]/.test(text[at] ?? '') ? at + 1 : at);
  }
  return starts;
}

/** Whether a line Ares wrote rests on what he was handed for it. */
export function checkGrounded(text: string, handed: string, options: GroundingOptions = {}): Grounding {
  const line = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!line) return { ok: false, why: 'it was empty' };
  if (line.length > MAX_LINE) return { ok: false, why: 'it was too long' };
  const sentences = line.split(/(?<=[.!?])\s+(?=[“"‘(]?[\p{Lu}\d])/u).filter(Boolean);
  if (sentences.length > MAX_SENTENCES) return { ok: false, why: 'it was more than a few sentences' };

  const source = fold(handed);
  const sourceWords = wordsOf(handed);
  const sourceNumbers = new Set([...handed.normalize('NFKC').matchAll(NUMBER)].map(([n]) => numberOf(n)));

  for (const [token] of line.matchAll(NUMBER)) {
    if (!sourceNumbers.has(numberOf(token))) return { ok: false, why: 'a number it wasn’t given' };
  }
  for (const word of fold(line).match(/[a-z]+/g) ?? []) {
    const number = NUMBER_WORDS[word];
    if (number && !sourceNumbers.has(number)) return { ok: false, why: 'a number it wasn’t given' };
  }
  for (const [token] of line.matchAll(IDENTIFIER)) {
    if (!source.includes(fold(token))) return { ok: false, why: 'an Item it wasn’t given' };
  }
  for (const match of line.matchAll(QUOTED)) {
    const quoted = fold(match[1] ?? match[2] ?? match[3] ?? '');
    if (quoted && !source.includes(quoted)) return { ok: false, why: 'a quote it wasn’t given' };
  }
  for (const [day] of line.matchAll(DAY_WORDS)) {
    if (!source.includes(day.toLowerCase())) return { ok: false, why: 'a day it wasn’t given' };
  }
  // Identifiers were checked whole: their letters aren't names.
  const words = line.replace(IDENTIFIER, (token) => '0'.repeat(token.length));
  const starts = sentenceStarts(words);
  for (const match of words.matchAll(CAPITALISED)) {
    const word = match[0].replace(/[’'-]+$/, '').replace(/[’']s$/, '');
    const folded = fold(word);
    if (sourceWords.has(folded) || VOCABULARY.has(folded)) continue;
    if (starts.has(match.index ?? -1) && OPENINGS.has(folded)) continue;
    return { ok: false, why: 'a name it wasn’t given' };
  }
  const named = options.mustName?.filter(Boolean) ?? [];
  if (named.length && !named.some((name) => fold(line).includes(fold(name)))) {
    return { ok: false, why: 'it doesn’t say what it is about' };
  }
  return { ok: true };
}
