// Links in a Daily Note open in the system browser, never in Commander's window, and only these kinds:
// web pages and email. The main process checks again before it opens anything.

// The WHATWG URL parser, there in every runtime Commander has (Node, Electron, the window); this
// package's ES-only lib settings leave it out.
type ParsedUrl = { protocol: string; hostname: string; pathname: string };
declare const URL: new (url: string) => ParsedUrl;

const OPENABLE = new Set(['http:', 'https:', 'mailto:']);
const MAX_LENGTH = 4096;

/** Whether a link may be opened: an http(s) URL with a host, or a mailto: address. */
export function isOpenableLink(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_LENGTH) return false;
  let parsed: ParsedUrl;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!OPENABLE.has(parsed.protocol)) return false;
  if (parsed.protocol === 'mailto:') return parsed.pathname.length > 0;
  // `new URL('http:///path')` takes "path" as the host; only `//host` counts as having one.
  return parsed.hostname.length > 0 && /^https?:\/\/[^/]/i.test(url.trim());
}
