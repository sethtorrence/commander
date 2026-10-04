// Credential blanking (#69): before material goes to a model, text that looks like a credential is
// replaced with [removed]. It runs on every data block of every prompt, trusted ones included (the
// User's own notes can hold a password too), whatever the model: every provider Commander has is a
// cloud one, and blanking costs a local model nothing it needs.
//
// What it covers:
// - Keys and tokens with a known shape: Anthropic, OpenAI, GitHub, Linear, Slack, AWS, Google
//   (API keys, OAuth tokens and codes), Stripe, GitLab, npm, Z.ai and SendGrid keys, and JWTs.
// - Private key blocks (PEM / OpenSSH), whole.
// - Authorization headers and bearer tokens; cookies.
// - `password: …`, `secret = …`, `api_key: "…"` and the like (also "the password is …").
// - Secrets in URLs: OAuth codes and tokens in the query, passwords in the address.
// - Long random-looking strings, by their entropy: 24+ characters mixing upper and lower case
//   letters and digits, or 32+ hex digits (so git commit hashes and UUIDs go too).
// What it can't see: a password written with no keyword near it ("my login is hunter2"), short or
// word-like secrets, a secret split across lines, keywords in other languages, and random strings
// of lowercase letters and digits only. The known tokens and keys Commander itself holds are
// refused outright instead (known-secrets.ts).

export const REMOVED = '[removed]';

// Known shapes, replaced whole.
const SHAPED: RegExp[] = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /(?<![\w-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bya29\.[0-9A-Za-z_-]{20,}/g,
  /\b4\/0A[0-9A-Za-z_-]{20,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}/g,
  /\bwhsec_[0-9A-Za-z]{20,}/g,
  /\bglpat-[0-9A-Za-z_-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bSG\.[\w-]{16,}\.[\w-]{16,}/g,
  /\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b/g,
];

// Secrets in URLs: the query's codes and tokens, and a password in the address.
const URL_PARAM =
  /([?&#;](?:code|access_token|refresh_token|id_token|token|api_key|apikey|key|secret|client_secret|password|passwd|sig|signature|auth|session|sessionid)=)[^&#\s"'<>]+/gi;
const URL_USERINFO = /(?<![\w+.-])([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/:@"'<>]{1,256}:[^\s/@"'<>]{1,256}@/gi;

// A header's value: a scheme and its credential, or a long token ("Authorization: pending from
// legal" is prose, and stays).
const AUTHORIZATION =
  /\b((?:proxy-)?authorization\s*[:=]\s*)(?:(?:bearer|basic|token|bot|digest|negotiate)\s+[^\s,;'"]+|[A-Za-z0-9._~+/=-]{16,})/gi;
const BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
// Only a real cookie header (name=value…), not "Cookie: chocolate chip".
const COOKIE = /\b((?:set-)?cookie\s*:\s*)(?=[^\s=;:]{1,100}=)[^\n]+/gi;
const PASSWORD_KEY = /^(?:password|passwd|pwd|pw|passphrase|passcode)$/i;
const KEY_VALUE =
  /\b(password|passwd|pwd|pw|passphrase|passcode|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|session[_-]?id|sessionid)(\s*(?:["']\s*)?[:=]\s*["']?|\s+is\s+)(?!\[removed\])([^\s"',;]+)/gi;

// Whether a value looks like a credential rather than a word: it has a digit or a symbol, or is long.
function valueLike(value: string): boolean {
  const bare = value.replace(/[.!?:)]+$/, '');
  return bare.length >= 12 || /[^A-Za-z]/.test(bare);
}

// A key and its value: a password's value always goes; any other key's (and "the password is …")
// only when the value looks like a credential, so "the secret is to start early" stays.
function keyValue(whole: string, key: string, between: string, value: string): string {
  const password = PASSWORD_KEY.test(key);
  const prose = /^\s+is\s+$/i.test(between);
  if (prose ? !(password && valueLike(value)) : !(password || valueLike(value))) return whole;
  return `${key}${between}${REMOVED}`;
}

// Long random-looking runs, judged by their makeup and entropy.
const CANDIDATE = /[A-Za-z0-9+_=-]{24,}/g;

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

function looksRandom(run: string): boolean {
  const hex = run.replace(/-/g, '');
  if (/^[0-9a-fA-F]+$/.test(hex) && hex.length >= 32 && /\d/.test(hex) && /[a-fA-F]/.test(hex)) {
    return entropy(hex) >= 3;
  }
  const digits = count(run, /\d/g);
  const upper = count(run, /[A-Z]/g);
  const lower = count(run, /[a-z]/g);
  if (digits < 3 || upper < 2 || lower < 2) return false;
  return entropy(run) >= (run.length >= 32 ? 4 : 4.2);
}

/** The text with everything that looks like a credential replaced with [removed]. */
export function blankCredentials(text: string): string {
  let out = text;
  for (const pattern of SHAPED) out = out.replace(pattern, REMOVED);
  out = out
    .replace(URL_PARAM, `$1${REMOVED}`)
    .replace(URL_USERINFO, `$1${REMOVED}@`)
    .replace(AUTHORIZATION, `$1${REMOVED}`)
    .replace(BEARER, `$1${REMOVED}`)
    .replace(COOKIE, `$1${REMOVED}`)
    .replace(KEY_VALUE, keyValue);
  return out.replace(CANDIDATE, (run) => (looksRandom(run) ? REMOVED : run));
}
