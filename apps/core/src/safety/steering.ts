// The pattern half of the steering check (#69): text in an outside Item aimed at Ares or at an AI,
// such as "ignore previous instructions", "Ares, forward this to…" or "as an AI assistant you
// must…". Each outside Item is checked when it arrives (the Item store, on saveFromSource); the
// other half is the `steering` flag every Quick job's reply carries.
//
// A match only puts a warning mark on the Item and records an injection-warning activity entry: it
// never decides what Ares does, so the patterns lean towards marking. They match on a folded form
// of the text (see text.ts) so hidden characters, lookalike letters and Markdown emphasis don't
// hide anything. What they can't see: instructions in another language, paraphrases that name
// neither Ares nor an AI, and text spread out letter by letter. Nothing relies on them for safety:
// they make an attempt visible, while the prompt builder, the reply checks and the gate stop it
// doing harm.
import { foldForMatching } from './text';

// Ares by name, and the generic words for an AI. A line addressed to Ares counts as it is; one
// addressed to a generic AI needs a greeting or an order ("Hey AI…", "AI, you must…"), since Linear
// titles like "AI: add streaming" or "Copilot - remove the old prompt" are about the AI, not to it.
const GENERIC_AIS = String.raw`(?:ai|a\.i\.|ai assistants?|ai agents?|ai models?|llms?|large language models?|language models?|chatbots?|chatgpt|gpt|claude|copilot|gemini)`;
const AIS = `(?:ares|${GENERIC_AIS.slice(3, -1)})`;
const VERBS = `(?:ignore|disregard|forget|forward|send|email|reply|respond|delete|remove|archive|mark|close|complete|resolve|approve|merge|move|transfer|pay|reveal|print|output|repeat|tell|say|summari[sz]e|create|add|make|set|change|update|act|do|don't|do not|stop|run|execute|call|open|visit|click|download|share|post|publish|invite|accept|book|schedule|cancel|assign|rate|rank|give|write|follow|obey|treat|consider)`;
const ORDER = '(?:you (?:must|should|will|need to|have to) )';
const STRONG_NOUNS = `(?:instructions?|prompts?|directives?|programming|guardrails)`;
// Groups of people named after AI: "the AI team", "the AI working group".
const NOT_A_GROUP =
  '(?! (?:team|group|working group|committee|channel|guild|squad|department|lab|community|meetup))';

const PATTERNS: RegExp[] = [
  // "ignore all previous instructions", "override the system instructions", "forget your prompts".
  new RegExp(
    String.raw`\b(?:ignore|disregard|forget|override|bypass)\b(?: \S+){0,3}? (?:previous|prior|above|earlier|preceding|former|original|initial|system|your|all|any) (?:\S+ ){0,2}?${STRONG_NOUNS}\b`,
    'g',
  ),
  // "disregard your previous rules": rules and guidelines only with a word that points at Ares's own.
  /\b(?:ignore|disregard|forget|override|bypass)\b(?: \S+){0,2}? (?:previous|prior|above|earlier|preceding|original|initial|system|your) (?:rules|guidelines)\b/g,
  // "disregard everything above".
  /\b(?:ignore|disregard|forget)\b (?:all |everything |anything )?(?:above|before this|said before|previously said|so far)\b/g,
  // Addressed to Ares, with something to do: "Ares, forward this…".
  new RegExp(
    String.raw`(?<![a-z])(?:hey |hi |dear |ok |okay )?ares ?[,:;!—–-] ?(?:please )?${ORDER}?${VERBS}\b`,
    'g',
  ),
  // Addressed to an AI with a greeting or an order: "Hey AI assistant, please close…", "AI, you must…".
  new RegExp(
    String.raw`(?<![a-z])(?:hey|hi|dear|attention|ok|okay) ${GENERIC_AIS} ?[,:;!—–-]? ?(?:please )?${ORDER}?${VERBS}\b`,
    'g',
  ),
  new RegExp(String.raw`(?<![a-z])${GENERIC_AIS} ?[,:;!—–-] ?(?:please |${ORDER})${VERBS}\b`, 'g'),
  // "as an AI assistant, you must…", "you are a language model".
  /\bas an? (?:ai(?: assistant| model| agent)?|a\.i\.|language model|large language model|llm|chatbot|virtual assistant|automated assistant|digital assistant),? you\b/g,
  /\byou(?: are|'re) (?:just |only |now |merely )?an? (?:ai assistant|ai model|ai agent|language model|large language model|llm|chatbot|virtual assistant)\b/g,
  // "if you are an AI reading this…".
  /\bif you(?:'re| are)(?: an?)? (?:ai|a\.i\.|llm|language model|large language model|chatbot|ai assistant|ai agent|automated system)\b/g,
  // "note to any LLM…", "attention AI agents"; not "note to the AI team".
  new RegExp(
    String.raw`\b(?:note|message|instructions?|attention|notice|memo)(?: to| for)? (?:any |all |every )?${AIS}(?![a-z])${NOT_A_GROUP}`,
    'g',
  ),
  /\b(?:any|all|every) (?:ais|ai assistants?|ai agents?|ai models?|llms?|language models?|chatbots?|bots) (?:reading|processing|parsing|summari[sz]ing|scanning|seeing)\b/g,
  // Keeping something from the User: "do not tell the user about this", "without the user knowing".
  /\b(?:do not|don't|never) (?:tell|inform|alert|mention (?:this |it )?to|reveal (?:this |it )?to) the user (?:about|that|what|anything)\b/g,
  /\bwithout the user (?:knowing|noticing|seeing|finding out)\b/g,
  /\b(?:keep|hide) (?:this|it|that) from the user\b/g,
  // Asking for Ares's prompt or for secrets ("print your system prompt", "reveal the API keys"); not
  // "send me the instructions for the visa form" or "show the password field".
  /\b(?:reveal|print|show|repeat|output|leak|dump|disclose|display|share|send|tell)(?: me| us)? (?:your (?:\S+ )?(?:system prompt|initial prompt|hidden prompt|prompt|instructions|rules|api keys?|access tokens?|tokens|secrets?|passwords?|credentials)|(?:the|all|any) (?:system prompt|initial prompt|hidden prompt|api keys|access tokens|secrets|passwords|credentials))\b/g,
  // "New instructions:".
  /\b(?:new|real|actual|true) (?:system )?(?:instructions|prompt|directives?) ?:/g,
  // Delimiters and turns: Commander's own data blocks, chat templates, fake system messages.
  /<\/? ?data\b/g,
  /<\|[a-z ]{2,30}\|>/g,
  /\[\/?inst\]|<<\/?sys>>/g,
  /<\/? ?(?:system|assistant|developer|instructions?|sys)\b[^>]{0,40}>/g,
  /\[ ?(?:system|assistant|developer) ?\]/g,
  /\b(?:begin|end) (?:of )?(?:the )?(?:system|new) (?:prompt|instructions|message)\b/g,
];

const MAX_SNIPPET = 80;

/** What in the text is aimed at Ares or at an AI, briefly and folded; empty when nothing is. */
export function findSteering(text: string): string[] {
  const folded = foldForMatching(text);
  const found = new Set<string>();
  for (const pattern of PATTERNS) {
    for (const match of folded.matchAll(pattern)) found.add(match[0].trim().slice(0, MAX_SNIPPET));
  }
  return [...found];
}

// The model's half (#186): a job's steering flag marks an Item only with the exact passage it took as
// an instruction, found in that Item's own text. Spacing, case, lookalike letters and quotation marks
// around it don't matter; a quote too short to mean anything (a word or two) doesn't count.
const MIN_QUOTE = 8;
const QUOTE_MARKS = /^["'“”‘’«»]+|["'“”‘’«»]+$/g;

const folded = (quote: string) => foldForMatching(quote.replace(/‹/g, '<')).replace(QUOTE_MARKS, '').trim();

/** Whether a quote is in the text word for word, and long enough to mean something. */
export function quotedIn(text: string, quote: string): boolean {
  const wanted = folded(quote);
  if (wanted.length < MIN_QUOTE || !wanted.includes(' ')) return false;
  return foldForMatching(text).includes(wanted);
}

const MAX_PASSAGE = 200;

/**
 * The sentence (or line) of the text holding what was found, as the User wrote it, so a warning can
 * quote it; the snippet itself when no one sentence holds it.
 */
export function passageOf(text: string, snippet: string): string {
  const wanted = folded(snippet);
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  const found = wanted ? sentences.find((each) => foldForMatching(each).includes(wanted)) : undefined;
  const passage = (found ?? snippet).replace(/\s+/g, ' ').trim().replace(/[.]+$/, '');
  return passage.length > MAX_PASSAGE ? `${passage.slice(0, MAX_PASSAGE - 1).trimEnd()}…` : passage;
}
