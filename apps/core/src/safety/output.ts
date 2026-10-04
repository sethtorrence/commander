// Checks on what a model writes, before a job makes anything of it (#69):
// - The prompt builder's internal wording is stripped: a production prompt must never echo its
//   "untrusted data" instructions into what the User reads (the GLM-5.3-Flash evaluation, #31, saw
//   a summary end with exactly that).
// - Images are dropped (their words stay), and a URL stays only if it appears, exactly, in the
//   material the model was shown; any other becomes "[link removed]", and a Markdown link to one
//   becomes its words. javascript:, data: and file: addresses always go.
// Rendering adds its own layer: AresText (packages/ui) makes a URL clickable only if it is in the
// source Items, and never loads anything.
import { foldForMatching } from './text';

export const LINK_REMOVED = '[link removed]';

// Matched on the folded text of one sentence; any match strips the sentence. Narrow on purpose: an
// ordinary Todo ("Write the system prompt for the support bot", "Clean up untrusted certificates")
// must come through, so each pattern needs the builder's own framing, not just one of its words.
const INTERNAL_WORDING: RegExp[] = [
  /\buntrusted (?:data|content|material|input|text|blocks?|sources?|items?)\b/,
  /\b(?:is|are|was|were) untrusted\b/,
  /\bdata blocks?\b/,
  /<\/? ?data\b/,
  /\bdata-[0-9a-f]{6,}/,
  /\bsource ?= ?"?(?:outside|the user)/,
  /\b(?:treated|handled|regarded|considered)\b(?: \S+){0,4}? as (?:untrusted |plain |mere |just |only )?(?:data|material)\b/,
  /\bdata,? (?:and )?not (?:as )?instructions\b/,
  /\b(?:embedded|hidden|injected|planted) (?:instructions|commands|prompts)\b/,
  /\bi (?:did not|didn't|do not|don't|won't|will not|cannot|can't|never) (?:follow|obey|act on|execute|carry out|comply with)\b/,
  /\bno (?:\S+ )?(?:instructions|commands) (?:were|was|have been) (?:followed|obeyed|acted on|executed)\b/,
  /\b(?:looks? like|looked like|appears? to be|appeared to be|seems? to be|seemed to be|is|was|contains?|contained|attempted) (?:an? |a possible )?prompt injection\b/,
  /\b(?:the|this|my) system message\b/,
  /\bmy (?:system prompt|instructions|rules)\b/,
  /\bmaterial to work on\b/,
  /\b(?:block|ref) u\d+\b/,
];

// Whether a sentence uses the internal wording. Words the material itself holds don't count: the
// User wrote "treat the email as data, not instructions", say, and the model quoted it.
const mentionsInternals = (sentence: string, material: string) => {
  const folded = foldForMatching(sentence);
  return INTERNAL_WORDING.some((pattern) => {
    const match = pattern.exec(folded);
    return match !== null && !material.includes(match[0]);
  });
};

/**
 * The text without any sentence (or line) that mentions the prompt builder's internal wording,
 * unless the material the model was shown holds those words itself.
 */
export function stripInternalWording(text: string, material = ''): string {
  // Most text holds none of it: one look at the whole, before going sentence by sentence.
  const folded = foldForMatching(text);
  if (!INTERNAL_WORDING.some((pattern) => pattern.test(folded))) return text;
  const foldedMaterial = foldForMatching(material);
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    const sentences = line.split(/(?<=[.!?]["')\]]{0,3})\s+/);
    const kept = sentences.filter((sentence) => !mentionsInternals(sentence, foldedMaterial));
    if (kept.length === sentences.length) lines.push(line);
    else if (kept.length) lines.push(kept.join(' ').trimEnd());
  }
  return lines.join('\n').trim() === '' ? '' : lines.join('\n');
}

const URL = /\bhttps?:\/\/[^\s<>"'`[\]()“”‘’«»]+/gi;
const TRAILING = /[.,;:!?'"]+$/;

/** The web addresses in a text, bare or in Markdown links, without trailing punctuation. */
export function urlsIn(text: string): string[] {
  return [...text.matchAll(URL)].map((match) => match[0].replace(TRAILING, ''));
}

const MARKDOWN_LINK =
  /(!?)\[([^[\]\n]{0,500})\]\( {0,10}<?([^\s()<>]{0,2000})>?(?: {1,10}"[^"\n]{0,500}")? {0,10}\)/g;
const DANGEROUS = /\b(?:javascript|vbscript):\S+|\bdata:[a-z]+\/\S+|\bfile:\/\/\S*/gi;

/** A model's text with images dropped and every URL not in the material removed. */
export function keepSourcedUrls(text: string, material: string): string {
  const sourced = new Set(urlsIn(material));
  return text
    .replace(DANGEROUS, LINK_REMOVED)
    .replace(MARKDOWN_LINK, (whole, image: string, words: string, href: string) => {
      if (image) return words;
      return sourced.has(href.replace(TRAILING, '')) ? whole : words;
    })
    .replace(URL, (url) => {
      const bare = url.replace(TRAILING, '');
      return sourced.has(bare) ? url : `${LINK_REMOVED}${url.slice(bare.length)}`;
    });
}

/** One string a model wrote, made safe to use: internal wording stripped, unsourced URLs removed. */
export function cleanModelText(text: string, material: string): string {
  return keepSourcedUrls(stripInternalWording(text, material), material);
}

/** A model's whole reply with every string in it cleaned (cleanModelText); the rest as it was. */
export function cleanOutput<T>(value: T, material: string): T {
  if (typeof value === 'string') return cleanModelText(value, material) as T;
  if (Array.isArray(value)) return value.map((entry) => cleanOutput(entry, material)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cleanOutput(entry, material)]),
    ) as T;
  }
  return value;
}
