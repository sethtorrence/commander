/*
  Finishes Links from GitHub (#119): after each GitHub sync, a pull request whose title, branch name
  or body names a Linear issue Commander holds (by identifier, "ENG-412"), or whose closing issue is
  itself linked to one, gets a finishes Link to it, made by the Source. These read the text; the Core
  matches what they find against the Linear issues it holds, so an identifier with no synced issue
  makes nothing.

  - Identifiers are matched whatever their case (Linear writes branches as `priya/eng-412-…`).
  - An identifier only referred to, after one of Linear's non-closing magic words ("Part of ENG-412",
    "Related to", "Contributes to", "Toward(s)", "Ref(s)", "References"), finishes nothing.
  - Closing issues are those GitHub lists for the pull request, and those its body names with one of
    GitHub's closing keywords (close(s/d), fix(es/ed), resolve(s/d)): GitHub lists none for a pull
    request into a branch other than the default one.
*/

// A team key (a letter, then letters or digits) and a number. Underscores and slashes border words
// in branch names too.
const IDENTIFIER = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,7})(?![A-Za-z0-9])/g;
// Linear's non-closing magic words, right before an identifier.
const ONLY_REFERS =
  /(?:^|[^A-Za-z])(?:part\s+of|related\s+to|contributes\s+to|towards?|refs?|references)\s*:?\s*$/i;

/** The Linear identifiers a text names as work it finishes, upper-cased, once each, in order. */
export function linearIdentifiersIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(IDENTIFIER)) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 40), match.index);
    if (ONLY_REFERS.test(before)) continue;
    found.add(`${match[1]?.toUpperCase()}-${match[2]}`);
  }
  return [...found];
}

export type IssueRef = { owner: string; name: string; number: number };

const NAME = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})';
const REPO = '[A-Za-z0-9._-]{1,100}';
const CLOSING = new RegExp(
  `(?<![A-Za-z0-9])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s*(?:(?:https?://[^/\\s]+/(${NAME})/(${REPO})/issues/(\\d+))|(?:(${NAME})/(${REPO}))?#(\\d+))(?![A-Za-z0-9])`,
  'gi',
);

/** The issues a pull request's body closes with GitHub's closing keywords, once each, in order. */
export function closingIssueRefs(body: string, repo: { owner: string; name: string }): IssueRef[] {
  const found = new Map<string, IssueRef>();
  for (const match of body.matchAll(CLOSING)) {
    const [, urlOwner, urlName, urlNumber, owner, name, number] = match;
    const ref: IssueRef = urlNumber
      ? { owner: urlOwner ?? '', name: urlName ?? '', number: Number(urlNumber) }
      : { owner: owner ?? repo.owner, name: name ?? repo.name, number: Number(number) };
    const key = `${ref.owner}/${ref.name}#${ref.number}`.toLowerCase();
    if (!found.has(key)) found.set(key, ref);
  }
  return [...found.values()];
}
