import { blockTags, type Project } from '@commander/domain';
import { accentColour, accentTextColour } from '@commander/ui';

/*
  The `#LT` shorthand drawn as its Badge, inline in a Block's text: the code stamped on its Project's
  accent. The text stays the browser's to edit (a plain-text contenteditable), so the stamp is a CSS
  Custom Highlight over the characters rather than an element in the text; the caret, selection and
  every other formatting of the text are left alone. One highlight per Project, named after its code.
  Where the Highlight API is missing (the unit tests' jsdom) the text simply shows as typed.
*/

type Coded = Pick<Project, 'id' | 'code' | 'accent' | 'archived'>;

const ranges = new WeakMap<HTMLElement, { name: string; range: Range }[]>();
const styled = new Map<string, string>();

const highlights = () => (typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null);
const nameOf = (code: string) => `commander-badge-${code.toLowerCase()}`;

// The highlight's look: the Badge's accent and text colour, kept in one stylesheet.
function style(name: string, project: Coded) {
  const rule = `::highlight(${name}) { background-color: ${accentColour(project.accent)}; color: ${
    accentTextColour(project.accent) ?? 'var(--on-accent)'
  }; }`;
  if (styled.get(name) === rule) return;
  styled.set(name, rule);
  let sheet = document.getElementById('commander-badge-highlights');
  if (!sheet) {
    sheet = document.createElement('style');
    sheet.id = 'commander-badge-highlights';
    document.head.append(sheet);
  }
  sheet.textContent = [...styled.values()].join('\n');
}

// A range over characters `start` to `end` of the element's text.
function rangeOver(element: HTMLElement, start: number, end: number): Range | null {
  const range = document.createRange();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.nodeValue?.length ?? 0;
    if (!started && seen + length > start) {
      range.setStart(node, start - seen);
      started = true;
    }
    if (started && seen + length >= end) {
      range.setEnd(node, end - seen);
      return range;
    }
    seen += length;
  }
  return null;
}

/** Stamps the known codes in a Block's text as Badges, replacing what was stamped there before. */
export function highlightTags(element: HTMLElement, projects: readonly Coded[]): void {
  const registry = highlights();
  if (!registry) return;
  clearTags(element);
  const text = element.textContent ?? '';
  const mine: { name: string; range: Range }[] = [];
  for (const tag of blockTags(text, projects)) {
    const project = projects.find((p) => p.id === tag.projectId);
    const range = project && rangeOver(element, tag.start, tag.end);
    if (!project || !range) continue;
    const name = nameOf(project.code);
    style(name, project);
    let highlight = registry.get(name);
    if (!highlight) {
      highlight = new Highlight();
      registry.set(name, highlight);
    }
    highlight.add(range);
    mine.push({ name, range });
  }
  ranges.set(element, mine);
}

/** Takes a Block's stamps away (it left the page). */
export function clearTags(element: HTMLElement): void {
  const registry = highlights();
  for (const { name, range } of ranges.get(element) ?? []) registry?.get(name)?.delete(range);
  ranges.delete(element);
}
