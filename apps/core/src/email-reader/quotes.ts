// Quoted history in an email's HTML (#134: folded behind "…"). Mail clients mark the message being
// replied to in their own ways: Gmail's `gmail_quote`, Apple Mail's and Thunderbird's
// `<blockquote type="cite">`, Yahoo's `yahoo_quoted`, Proton's `protonmail_quote`, and Outlook's
// reply header (`divRplyFwdMsg`, `appendonsend`), after which everything is the earlier message.
// Only trailing history is folded: a quote with the reply written after it (between its lines) stays,
// and so does a message that is nothing but a quote (a forward), so folding never hides what the
// sender wrote.

// Containers holding the quote itself.
const CONTAINERS = [
  'div.gmail_quote',
  'blockquote.gmail_quote',
  'blockquote[type="cite" i]',
  'div.yahoo_quoted',
  'blockquote.protonmail_quote',
];
// Markers after which the rest of the message is the quote.
const MARKERS = ['#divRplyFwdMsg', '#appendonsend', 'div.OutlookMessageHeader', 'div.moz-cite-prefix'];

const SHOW_TEXT = 4; // NodeFilter.SHOW_TEXT
const PRECEDING = 2; // Node.DOCUMENT_POSITION_PRECEDING
const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING
const CONTAINED_BY = 16; // Node.DOCUMENT_POSITION_CONTAINED_BY
// Only the first candidates are considered (a message with more is hardly a reply).
const CANDIDATES_MAX = 50;

const significant = (text: string | null) => /[^\s\u00a0\u200b\ufeff]/.test(text ?? '');

// The first and last text nodes with something in them: whether any text comes before or after an
// element is whether the first comes before it, or the last after it (and not inside it).
function textEnds(body: Element): { first: Node | null; last: Node | null } {
  const walker = body.ownerDocument.createTreeWalker(body, SHOW_TEXT);
  let first: Node | null = null;
  let last: Node | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!significant(node.textContent)) continue;
    first ??= node;
    last = node;
  }
  return { first, last };
}

// Removes `from` and everything after it in the body.
function removeFrom(from: Element, body: Element) {
  for (let at: Element | null = from; at && at !== body; at = at.parentElement) {
    while (at.nextSibling) at.nextSibling.remove();
  }
  from.remove();
}

/**
 * Finds the email's trailing quoted history, and removes it when `remove`. Returns whether there was
 * some to fold. Linear in the size of the body.
 */
export function foldQuotes(body: Element, { remove }: { remove: boolean }): boolean {
  const { first, last } = textEnds(body);
  if (!first || !last) return false;
  const selector = [...CONTAINERS, ...MARKERS].join(',');
  const before = (node: Element) => !!(node.compareDocumentPosition(first) & PRECEDING);
  const after = (node: Element) => {
    const position = node.compareDocumentPosition(last);
    return !!(position & FOLLOWING) && !(position & CONTAINED_BY);
  };

  let seen = 0;
  for (const candidate of body.querySelectorAll(selector)) {
    if (++seen > CANDIDATES_MAX) break;
    // The outermost one of nested quotes.
    if (candidate.parentElement?.closest(selector)) continue;
    if (!before(candidate)) continue;
    const marker = MARKERS.some((each) => candidate.matches(each));
    if (!marker && after(candidate)) continue;
    if (remove) {
      if (marker) removeFrom(candidate, body);
      else {
        // Older Gmail puts "On …, … wrote:" just before its quote.
        const attribution = candidate.previousElementSibling;
        if (attribution?.matches('.gmail_attr')) attribution.remove();
        candidate.remove();
      }
    }
    return true;
  }
  return false;
}
