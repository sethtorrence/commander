/*
  The Markdown copy's serializer (#53): a Daily Note's Blocks in, the text of its `YYYY-MM-DD.md` out.
  A pure function, so the format is pinned by fixture tests (serialize.test.ts).

  - The first line says the file is a read-only copy.
  - A top-level heading Block (`# `, `## `, `### `) is a Markdown heading, with its children as a list
    beneath it; every other Block is a list item, nested by tabs (as Obsidian indents).
  - Block text is already Markdown (bold, italic, code, links, image embeds), so it goes in as it is,
    except: a Todo gets `[ ]` or `[x]`; a Block's own Project is added as `#LT` unless the text says it
    already (inherited Projects are not repeated); `[[project:<id>]]` becomes `[[Project name]]`; a
    calendar event's `[[event:<id>]]` (a meeting chip) becomes the meeting's line, "10:00–10:30 Weekly
    sync with Priya" (struck through when cancelled); an email's `[[email:<id>]]` becomes "Email from
    Dana Whitfield: Q4 budget"; and text Markdown would read as a list, checkbox or quote is escaped,
    since Commander shows it as text.
*/
import { blockLinkToken, blockTags, labelBlockLinks } from '@commander/domain';

export const READ_ONLY_NOTICE = '<!-- Read-only copy written by Commander. Edits here are overwritten. -->';

/** A Block as the copy needs it. */
export interface CopyBlock {
  id: string;
  parentId: string | null;
  position: string;
  text: string;
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

// A heading Block, as the Notes Section reads one (`#` straight before letters is a Project code).
const HEADING = /^#{1,3} /;

// Text at the start of a list item that Markdown would read as more than text.
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

  const listItem = (block: CopyBlock, depth: number, into: string[]) => {
    if (!isWritten(block)) return;
    const indent = '\t'.repeat(depth);
    const box = block.todo === 'done' ? '[x] ' : block.todo === 'open' ? '[ ] ' : '';
    const [first = '', ...rest] = escapeStart(textOf(block, projects)).split('\n');
    into.push(`${indent}- ${box}${first}`.trimEnd());
    for (const line of rest) into.push(`${indent}  ${line}`.trimEnd());
    for (const child of childrenOf(block.id)) listItem(child, depth + 1, into);
  };

  // Each part is a heading or a list; parts are separated by a blank line.
  const parts: string[][] = [];
  let list: string[] | null = null;
  for (const block of childrenOf(null)) {
    if (!isWritten(block)) continue;
    if (HEADING.test(block.text) && block.todo === null) {
      parts.push([textOf(block, projects).replace(/\s*\n\s*/g, ' ')]);
      const under: string[] = [];
      for (const child of childrenOf(block.id)) listItem(child, 0, under);
      parts.push(under);
      list = null;
    } else {
      if (!list) {
        list = [];
        parts.push(list);
      }
      listItem(block, 0, list);
    }
  }

  const body = parts.filter((part) => part.length).map((part) => part.join('\n'));
  return `${[READ_ONLY_NOTICE, ...body].join('\n\n')}\n`;
}
