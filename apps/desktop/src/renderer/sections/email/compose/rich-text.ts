import { type ComposeBlock, type ComposeBody, type ComposeRun, isComposeLink } from '@commander/domain';

/*
  The composer's editor and its model (#138). The editor is a contenteditable element, but what it
  holds is never trusted as HTML: it is read into the composer's model (paragraphs and lists of runs,
  bold, italic and links to web and mail addresses) and drawn back from it with only the elements the
  model allows, built one by one (never innerHTML). Pasting inserts text only, so nothing a page or
  another app put on the clipboard (styles, images, scripts) ever enters the window.
*/

const BLOCK_TAGS = new Set([
  'DIV',
  'P',
  'LI',
  'UL',
  'OL',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'PRE',
]);

type Marks = { bold: boolean; italic: boolean; href: string | null };

function merge(runs: ComposeRun[]): ComposeRun[] {
  const out: ComposeRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = out.at(-1);
    if (last && !!last.bold === !!run.bold && !!last.italic === !!run.italic && last.href === run.href)
      out[out.length - 1] = { ...last, text: last.text + run.text };
    else out.push(run);
  }
  return out;
}

const marked = (text: string, marks: Marks): ComposeRun => ({
  text,
  ...(marks.bold ? { bold: true } : {}),
  ...(marks.italic ? { italic: true } : {}),
  ...(marks.href ? { href: marks.href } : {}),
});

function marksOf(element: HTMLElement, marks: Marks): Marks {
  const tag = element.tagName;
  const weight = element.style?.fontWeight;
  const next: Marks = {
    bold: marks.bold || tag === 'B' || tag === 'STRONG' || weight === 'bold' || Number(weight) >= 600,
    italic: marks.italic || tag === 'I' || tag === 'EM' || element.style?.fontStyle === 'italic',
    href: marks.href,
  };
  if (tag === 'A') {
    const href = element.getAttribute('href') ?? '';
    next.href = isComposeLink(href) ? href.trim() : null;
  }
  return next;
}

/** What the editor holds, as the composer's model. */
export function readEditor(root: HTMLElement): ComposeBody {
  const blocks: ComposeBlock[] = [];
  let runs: ComposeRun[] = [];
  let open = false;
  const flush = (force = false) => {
    if (open || runs.length || force) blocks.push({ type: 'paragraph', runs: merge(runs) });
    runs = [];
    open = false;
  };
  const inline = (node: Node, marks: Marks, into: ComposeRun[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      into.push(marked((node.textContent ?? '').replace(/ /g, ' '), marks));
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === 'BR') return;
    const next = marksOf(node, marks);
    for (const child of node.childNodes) inline(child, next, into);
  };
  const walk = (node: Node, marks: Marks) => {
    if (node.nodeType === Node.TEXT_NODE) {
      runs.push(marked((node.textContent ?? '').replace(/ /g, ' '), marks));
      open = true;
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName;
    if (tag === 'BR') {
      flush(true);
      return;
    }
    if (tag === 'UL' || tag === 'OL') {
      flush();
      const items: ComposeRun[][] = [];
      for (const child of node.children) {
        if (child.tagName !== 'LI') continue;
        const item: ComposeRun[] = [];
        for (const each of child.childNodes) inline(each, marks, item);
        items.push(merge(item));
      }
      if (items.length) blocks.push({ type: 'list', ordered: tag === 'OL', items });
      return;
    }
    if (BLOCK_TAGS.has(tag)) {
      flush();
      const next = marksOf(node, marks);
      // An empty line (<div><br></div>) is a paragraph of its own.
      const only =
        node.childNodes.length === 1 &&
        node.firstChild instanceof HTMLElement &&
        node.firstChild.tagName === 'BR';
      if (only || node.childNodes.length === 0) {
        blocks.push({ type: 'paragraph', runs: [] });
        return;
      }
      for (const child of node.childNodes) walk(child, next);
      flush();
      return;
    }
    const next = marksOf(node, marks);
    for (const child of node.childNodes) walk(child, next);
  };
  for (const child of root.childNodes) walk(child, { bold: false, italic: false, href: null });
  flush();
  return blocks;
}

function runNode(run: ComposeRun, document: Document): Node {
  let node: Node = document.createTextNode(run.text);
  if (run.italic) {
    const italic = document.createElement('i');
    italic.append(node);
    node = italic;
  }
  if (run.bold) {
    const bold = document.createElement('b');
    bold.append(node);
    node = bold;
  }
  if (run.href && isComposeLink(run.href)) {
    const link = document.createElement('a');
    link.setAttribute('href', run.href.trim());
    link.setAttribute('rel', 'noreferrer noopener');
    link.setAttribute('target', '_blank');
    link.append(node);
    node = link;
  }
  return node;
}

/** Draws the model into the editor: only <div>, <ul>/<ol>/<li>, <b>, <i> and <a>, built one by one. */
export function writeEditor(root: HTMLElement, body: ComposeBody) {
  const document = root.ownerDocument;
  const nodes: Node[] = [];
  for (const block of body) {
    if (block.type === 'paragraph') {
      const line = document.createElement('div');
      if (block.runs.some((run) => run.text))
        for (const run of block.runs) line.append(runNode(run, document));
      else line.append(document.createElement('br'));
      nodes.push(line);
    } else {
      const list = document.createElement(block.ordered ? 'ol' : 'ul');
      for (const runs of block.items) {
        const item = document.createElement('li');
        for (const run of runs) item.append(runNode(run, document));
        if (!runs.length) item.append(document.createElement('br'));
        list.append(item);
      }
      nodes.push(list);
    }
  }
  if (!nodes.length) {
    const line = document.createElement('div');
    line.append(document.createElement('br'));
    nodes.push(line);
  }
  root.replaceChildren(...nodes);
}
