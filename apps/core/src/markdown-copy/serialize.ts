/*
  The Markdown copy's serializer (#53): a Daily Note's Blocks in, the text of its `YYYY-MM-DD.md` out.
  A pure function, so the format is pinned by fixture tests (serialize.test.ts).

  - The first line says the file is a read-only copy.
  - Each Block is written as its style (#239): a heading as `#` to `###`, a bullet as `- `, a numbered
    item as `1. ` (counting up along a run of them), a Todo as `- [ ] ` or `- [x] `, and a plain line
    as a paragraph of its own. List items nest by tabs (as Obsidian indents) and follow one another;
    everything else is set apart by a blank line.
  - A meeting chip and every line under it are quoted (`> `), as is any other quote line: the
    meeting's notes sit in its quote.
  - Block text is already Markdown (bold, italic, code, links, image embeds), so it goes in as it is,
    except: a Block's own Project is added as `#LT` unless the text says it already (inherited Projects
    are not repeated); `[[project:<id>]]` becomes `[[Project name]]`; a calendar event's
    `[[event:<id>]]` (a meeting chip) becomes the meeting's line, "10:00–10:30 Weekly sync with Priya"
    (struck through when cancelled); an email's `[[email:<id>]]` becomes "Email from Dana Whitfield: Q4
    budget"; and text Markdown would read as a list, checkbox or quote is escaped, since Commander
    shows it as text.
*/
import {
  type BlockStyle,
  blockLinkToken,
  blockTags,
  labelBlockLinks,
  meetingChipEventId,
} from '@commander/domain';

export const READ_ONLY_NOTICE = '<!-- Read-only copy written by Commander. Edits here are overwritten. -->';

/** A Block as the copy needs it. */
export interface CopyBlock {
  id: string;
  parentId: string | null;
  position: string;
  text: string;
  /** How its line looks (#239). */
  style: BlockStyle;
  /** The Project the Block was filed under itself (not one it inherits), or null. */
  ownProjectId: string | null;
  /** Its Todo, if it is one. */
  todo: 'open' | 'done' | null;
}

/** How Projects (and meetings) read in the copy: undefined for one that isn't known. */
export interface CopyProjects {
  code(projectId: string): string | undefined;
  /** The Project's name; a merged Project's is the one it went into. */
  name(projectId: string): string | undefined;
  /** A calendar event as one line: "10:00–10:30 Weekly sync with Priya". */
  meeting?(eventId: string): string | undefined;
  /** An email as one line: "Email from Dana Whitfield: Q4 budget". */
  email?(emailId: string): string | undefined;
}

// Text at the start of a line that Markdown would read as more than text.
const LIST_MARK = /^([-+*])(?=\s|$)/;
const ORDERED_MARK = /^(\d{1,9})([.)])(?=\s|$)/;
const CHECKBOX = /^\[[ xX]\]/;

function escapeStart(text: string): string {
  if (LIST_MARK.test(text) || CHECKBOX.test(text) || text.startsWith('>')) return `\\${text}`;
  return text.replace(ORDERED_MARK, '$1\\$2');
}

// What may not sit inside an Obsidian `[[link]]`: it would end the link, alias it or point into it.
const wikiSafe = (name: string) =>
  name
    .replace(/[[\]|#^]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function textOf(block: CopyBlock, projects: CopyProjects): string {
  let text = labelBlockLinks(block.text, (target) => {
    if (target.type === 'day') return blockLinkToken(target);
    if (target.type === 'event') return projects.meeting?.(target.eventId) ?? 'a meeting';
    if (target.type === 'email') return projects.email?.(target.emailId) ?? 'an email';
    const name = projects.name(target.projectId);
    const safe = name === undefined ? '' : wikiSafe(name);
    return safe ? `[[${safe}]]` : blockLinkToken(target);
  });
  const code = block.ownProjectId ? projects.code(block.ownProjectId) : undefined;
  if (code && block.ownProjectId) {
    const named = blockTags(block.text, [{ id: block.ownProjectId, code, archived: false }]).length > 0;
    if (!named) text = text.trim() ? `${text} #${code}` : `#${code}`;
  }
  return text;
}

const byPosition = (a: CopyBlock, b: CopyBlock) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

// A Block's lines in the file: a list item (a list's items follow one another) or a block of its own
// (a heading, a paragraph), in a quote or not.
interface Run {
  list: boolean;
  quote: boolean;
  lines: string[];
}

const LIST_STYLES = new Set<BlockStyle>(['bullet', 'numbered']);
// A Block with a Todo is a checkbox whatever its style (Ares may have added the Todo for it); one
// whose Todo was deleted is a plain line.
const isListItem = (block: CopyBlock) => block.todo !== null || LIST_STYLES.has(block.style);
const HEADINGS: Partial<Record<BlockStyle, number>> = { 'heading-1': 1, 'heading-2': 2, 'heading-3': 3 };

/** The Markdown copy of a Daily Note with these (live) Blocks. */
export function dailyNoteMarkdown(blocks: readonly CopyBlock[], projects: CopyProjects): string {
  const ids = new Set(blocks.map((block) => block.id));
  const children = new Map<string | null, CopyBlock[]>();
  for (const block of [...blocks].sort(byPosition)) {
    // A Block whose parent isn't here goes to the top, as the outliner shows it.
    const parentId = block.parentId !== null && ids.has(block.parentId) ? block.parentId : null;
    children.set(parentId, [...(children.get(parentId) ?? []), block]);
  }
  const childrenOf = (id: string | null) => children.get(id) ?? [];

  // Whether a Block has anything to show: text, a Todo, or something written below it. Blocks caught
  // in a loop of parents are never reached from the top, so they are left out.
  const written = new Map<string, boolean>();
  const isWritten = (block: CopyBlock): boolean => {
    const known = written.get(block.id);
    if (known !== undefined) return known;
    written.set(block.id, false);
    const result =
      block.text.trim() !== '' ||
      block.todo !== null ||
      !!(block.ownProjectId && projects.code(block.ownProjectId)) ||
      childrenOf(block.id).some(isWritten);
    written.set(block.id, result);
    return result;
  };

  const runs: Run[] = [];
  // `depth` is how deep in a list the Block sits, or null when it isn't under a list item; `number`
  // is a numbered item's number.
  const write = (block: CopyBlock, quote: boolean, depth: number | null, number: number) => {
    const quoted = quote || block.style === 'quote' || meetingChipEventId(block.text) !== null;
    const text = textOf(block, projects);
    const heading = block.todo === null ? HEADINGS[block.style] : undefined;
    let under = depth;
    if (isListItem(block)) {
      const indent = '\t'.repeat(depth ?? 0);
      const box = block.todo === 'done' ? '[x] ' : block.todo === 'open' ? '[ ] ' : '';
      const mark = block.style === 'numbered' && !box ? `${number}. ` : `- ${box}`;
      const [first = '', ...rest] = escapeStart(text).split('\n');
      const lines = [`${indent}${mark}${first}`, ...rest.map((line) => `${indent}  ${line}`)];
      runs.push({ list: true, quote: quoted, lines });
      under = (depth ?? 0) + 1;
    } else if (heading) {
      runs.push({
        list: false,
        quote: quoted,
        lines: [`${'#'.repeat(heading)} ${text.replace(/\s*\n\s*/g, ' ')}`],
      });
      under = null;
    } else if (text.trim()) {
      // A line under a list item (as Blocks written before line styles may be) carries on that item.
      const indent = '\t'.repeat(depth ?? 0);
      const lines = escapeStart(text)
        .split('\n')
        .map((line) => `${indent}${line}`);
      runs.push({ list: depth !== null, quote: quoted, lines });
    }
    writeChildren(block.id, quoted, under);
  };
  // Numbered items count up from 1 along a run of them; anything else between them starts again.
  const writeChildren = (parentId: string | null, quote: boolean, depth: number | null) => {
    let number = 0;
    for (const child of childrenOf(parentId)) {
      if (!isWritten(child)) continue;
      number = child.style === 'numbered' && child.todo === null ? number + 1 : 0;
      write(child, quote, depth, number);
    }
  };
  writeChildren(null, false, null);

  // A list's items follow one another; anything else comes after a blank line (a blank quote line
  // inside a quote).
  let body = '';
  runs.forEach((run, i) => {
    const before = runs[i - 1];
    if (before) {
      if (before.list && run.list && before.quote === run.quote) body += '\n';
      else if (before.quote && run.quote) body += '\n>\n';
      else body += '\n\n';
    }
    body += run.lines.map((line) => (run.quote ? `> ${line}` : line).trimEnd()).join('\n');
  });
  return `${[READ_ONLY_NOTICE, ...(body ? [body] : [])].join('\n\n')}\n`;
}
