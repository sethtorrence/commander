// Text as it arrives from outside can look different to a model than to the User: characters that
// don't show (zero-width spaces, bidirectional controls, Unicode tag characters that spell out
// hidden ASCII) and lookalikes (fullwidth "＜", mathematical "𝐢𝐠𝐧𝐨𝐫𝐞", Cyrillic "о"). Before
// anything goes into a prompt it is normalised so the model reads what the User would see, and
// pattern checks (steering, safety wording) match on a folded form that sees through the tricks.

// Characters that render as nothing: soft hyphen, combining grapheme joiner, Arabic letter mark,
// Hangul fillers, Khmer vowel inherents, Mongolian selectors, zero-width spaces and joiners,
// directional marks and embeddings, word joiner and invisible operators, variation selectors,
// the byte order mark, interlinear annotations, musical formatting, and the tag and variation
// selector supplement planes.
const INVISIBLE =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: each of these is removed on its own, never combined
  /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/gu;
// Control characters other than tab and newline.
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u0084\u0086-\u009f]/g;
const LINE_BREAKS = /\r\n|[\r\u0085\u2028\u2029]/g;

/** Text as the User would see it: NFKC, one kind of line break, nothing invisible. */
export function normalise(text: string): string {
  return text.normalize('NFKC').replace(LINE_BREAKS, '\n').replace(INVISIBLE, '').replace(CONTROL, '');
}

// Unicode tag characters (U+E0020–U+E007E) mirror printable ASCII, invisibly.
const TAGS = /[\u{e0020}-\u{e007e}]+/gu;

/** Spells out what Unicode tag characters hide, so a pattern check can see it. */
export function revealHidden(text: string): string {
  return text.replace(
    TAGS,
    (run) =>
      ` ${[...run].map((char) => String.fromCharCode((char.codePointAt(0) as number) - 0xe0000)).join('')}`,
  );
}

// Letters from other scripts that look like Latin ones.
const LOOKALIKES: Record<string, string> = {
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  һ: 'h',
  і: 'i',
  ї: 'i',
  ј: 'j',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  ѕ: 's',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  ɡ: 'g',
  α: 'a',
  β: 'b',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
};
const LOOKALIKE = new RegExp(`[${Object.keys(LOOKALIKES).join('')}]`, 'g');

/**
 * A folded form for pattern checks only (never shown or sent): hidden text spelled out,
 * normalised, lowercased, lookalike letters folded to Latin, Markdown emphasis dropped and spacing
 * collapsed.
 */
export function foldForMatching(text: string): string {
  return normalise(revealHidden(text))
    .toLowerCase()
    .replace(LOOKALIKE, (char) => LOOKALIKES[char] ?? char)
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
