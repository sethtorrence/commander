// The User's text as an FTS5 query: every word must match, each quoted so nothing typed is read as
// FTS5 syntax, and the last one as a prefix while it is still being typed (no space after it).

const WORD = /[\p{L}\p{N}]+/gu;

export type WordQuery = {
  // The FTS5 MATCH expression, or null when the text has no words.
  match: string | null;
  // The text as typed, for exact matches: trimmed, single-spaced.
  exact: string;
};

export function wordQuery(text: string): WordQuery {
  const words = text.match(WORD) ?? [];
  const exact = text.trim().replace(/\s+/g, ' ');
  if (!words.length) return { match: null, exact };
  const typing = !/\s$/.test(text);
  const match = words
    .map((word, index) => `"${word}"${typing && index === words.length - 1 ? '*' : ''}`)
    .join(' ');
  return { match, exact };
}
