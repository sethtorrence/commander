import {
  type Filing,
  imageAttachmentOf,
  isOwnFiling,
  meetingChipEventId,
  type Project,
} from '@commander/domain';
import { cn } from '@commander/ui';
import {
  type ClipboardEvent,
  type CSSProperties,
  createContext,
  type KeyboardEvent,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { AskAres } from '../../links/AresButton';
import { BlockImage } from './BlockImage';
import { BlockIssueChips, BlockMenu } from './BlockLinear';
import { type OutlineLinks, useBlockLinks } from './BlockLinks';
import { BlockMargin } from './BlockMargin';
import { TodoCheck, TodoTag } from './BlockTodo';
import {
  formatShortcut,
  imageFiles,
  linkClicked,
  openBlockLink,
  pasteText,
  readImages,
  renderBlockText,
  showEdit,
} from './block-editor';
import { caretX, onFirstLine, onLastLine, placeCaret, placeCaretAtX, selectionIn } from './caret';
import { headingOf, isListItem, listNumbers, styleOf } from './line-styles';
import { MeetingPrep } from './MeetingPrep';
import { headingLevel, toggleMark } from './markdown';
import type { Notebook } from './notebook';
import { type Block, blockNumbers, type Caret, descendantCount, type Outline, treeOf } from './outline';
import { useTagPicker } from './TagPicker';
import { clearTags, highlightTags } from './tag-highlights';

/*
  One Daily Note's outline: each Block a row with its number, its line style's mark (a bullet, a
  number, a checkbox, a quote's bar, or nothing on a plain line) and its own editable text (a
  contenteditable, plain text only). The outliner keys are handled here and turned into Notebook
  edits; the Notebook answers with where the caret goes, and the stream puts it there after rendering.
  Moving between Blocks with the arrow keys walks the editable rows in page order, across days.
*/

export interface OutlineControls {
  notebook: Notebook;
  /** Puts the caret at a Block once it is on screen. */
  focus(caret: Caret | null): void;
  /** Block Projects, where Blocks have them (the Notes Section, not the daily template). */
  projects?: OutlineProjects;
  /** `[[` links: the picker's targets, chip labels and following a chip (BlockLinks.tsx). */
  links?: OutlineLinks;
  /** Send to Linear from a Block's margin menu, where Blocks can be sent (the Notes Section). */
  sendToLinear?: (day: string, block: Block) => void;
}

/** Block Projects in the outline (#51): the `#` picker, the inline Badges and the margin's picker. */
export interface OutlineProjects {
  /** The active Projects, for the `#` picker and the `#LT` drawn as Badges. */
  list: readonly Project[];
  /** Opens the Badge picker for a Block beside its margin Badge; `filing` is what it shows now. */
  pick(day: string, block: Block, filing: Filing, anchor: HTMLElement): void;
}

/** What each Block of a Daily Note shows of its Project, and what the Project filter leaves out. */
export interface ProjectView {
  /** The Project each Block shows: its own, or its parent's (block-projects.ts). */
  filings: ReadonlyMap<string, Filing>;
  /** Blocks the filter hides, and those it shows dimmed as context. */
  hidden: ReadonlySet<string>;
  dimmed: ReadonlySet<string>;
}

export const OutlineContext = createContext<OutlineControls | null>(null);

export function useControls(): OutlineControls {
  const controls = useContext(OutlineContext);
  if (!controls) throw new Error('A Daily Note outline needs its OutlineContext');
  return controls;
}

// Every editable row in the same stream (the Notes Section, or the daily template in Settings), in
// page order: the folded-away ones aren't rendered.
const editors = (element: HTMLElement) => [
  ...(element.closest('[data-notes-stream]') ?? document).querySelectorAll<HTMLElement>('[data-block-text]'),
];

export function neighbour(element: HTMLElement, step: 1 | -1): HTMLElement | undefined {
  const all = editors(element);
  return all[all.indexOf(element) + step];
}

function ensureVisible(element: HTMLElement) {
  const box = element.getBoundingClientRect();
  const top = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--body')) || 132;
  if (box.top < top + 20 || box.bottom > innerHeight - 110) element.scrollIntoView({ block: 'center' });
}

/** Focuses a row's text at an offset (or its end) and keeps it in view. */
export function focusText(element: HTMLElement, offset: number | 'end') {
  if (document.activeElement !== element) element.focus({ preventScroll: true });
  placeCaret(element, offset === 'end' ? (element.textContent ?? '').length : offset);
  ensureVisible(element);
}

// Keys every editable row shares: moving between rows, undo and redo. Returns whether it handled the key.
function sharedKey(event: KeyboardEvent<HTMLElement>, { notebook, focus }: OutlineControls): boolean {
  const element = event.currentTarget;
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (mod && !event.altKey && (key === 'z' || key === 'y')) {
    event.preventDefault();
    focus(key === 'z' && !event.shiftKey ? notebook.undo() : notebook.redo());
    return true;
  }
  const plain = !mod && !event.altKey && !event.shiftKey;
  if (plain && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    const up = event.key === 'ArrowUp';
    if (!(up ? onFirstLine(element) : onLastLine(element))) return true;
    const target = neighbour(element, up ? -1 : 1);
    if (!target) return true;
    event.preventDefault();
    const x = caretX(element);
    target.focus({ preventScroll: true });
    placeCaretAtX(target, x, up ? 'bottom' : 'top');
    ensureVisible(target);
    return true;
  }
  if (plain && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    const [start, end] = selectionIn(element);
    const length = (element.textContent ?? '').length;
    const left = event.key === 'ArrowLeft';
    if (start !== end || (left ? start !== 0 : end !== length)) return true;
    const target = neighbour(element, left ? -1 : 1);
    if (!target) return true;
    event.preventDefault();
    focusText(target, left ? 'end' : 0);
    return true;
  }
  return false;
}

// Text pasted into a Block stays one line of plain text.
function pastePlain(event: ClipboardEvent<HTMLElement>) {
  event.preventDefault();
  const text = event.clipboardData.getData('text/plain').replace(/\r?\n+/g, ' ');
  document.execCommand('insertText', false, text);
}

// The browser's own undo, paragraphs and formatting would fight the outline: they go through the keys.
function useNativeInputGuard(ref: React.RefObject<HTMLElement | null>, controls: OutlineControls) {
  const latest = useRef(controls);
  latest.current = controls;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const guard = (event: InputEvent) => {
      const { notebook, focus } = latest.current;
      if (event.inputType === 'historyUndo') focus(notebook.undo());
      else if (event.inputType === 'historyRedo') focus(notebook.redo());
      else if (
        event.inputType !== 'insertParagraph' &&
        event.inputType !== 'insertLineBreak' &&
        !event.inputType.startsWith('format')
      )
        return;
      event.preventDefault();
    };
    element.addEventListener('beforeinput', guard);
    return () => element.removeEventListener('beforeinput', guard);
  }, [ref]);
}

const BlockText = memo(function BlockText({ day, block }: { day: string; block: Block }) {
  const controls = useControls();
  const { notebook, focus } = controls;
  const ref = useRef<HTMLDivElement>(null);
  useNativeInputGuard(ref, controls);
  // `#` and letters offer the Projects; choosing one completes the code, as typing it would.
  const tags = useTagPicker(controls.projects?.list, (text, offset) => {
    notebook.type(day, block.id, text, offset);
    focus({ id: block.id, offset });
  });

  // Draws the text, `[[` chips included, and runs the `[[` picker (BlockLinks.tsx).
  const links = useBlockLinks({ day, block, notebook, focus, links: controls.links });
  const { label } = links;

  // The text is the browser's while typing (rendered again from it as it changes, markdown.ts); it is
  // set from the outline only when they differ (after an undo, a join or a split), or drawn again
  // when its chips' labels change (a Project renamed).
  const drawnWith = useRef<typeof label | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || (element.textContent === block.text && drawnWith.current === label)) return;
    drawnWith.current = label;
    renderBlockText(element, block.text, label);
  }, [block.text, label]);
  // `#LT` in the text is drawn as LT's Badge, again whenever the text changes.
  const projects = controls.projects?.list;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the text is read from the element, which follows `block.text`
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && projects) highlightTags(element, projects);
  }, [block.text, projects, label]);
  useEffect(() => {
    const element = ref.current;
    return () => {
      if (element) clearTags(element);
    };
  }, []);

  // A formatting shortcut or a pasted link: shown at once, and saved like typing.
  const apply = (element: HTMLElement, edit: { text: string; start: number; end: number }) => {
    showEdit(element, edit, label);
    notebook.type(day, block.id, edit.text);
  };
  const attach = (files: File[]) =>
    void readImages(files)
      .then((images) => notebook.attach(day, block.id, images))
      .then(focus);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || links.onKeyDown(event)) return;
    if (tags.onKeyDown(event)) return;
    const element = event.currentTarget;
    const mod = event.ctrlKey || event.metaKey;
    const { id } = block;
    const [start, end] = selectionIn(element);
    const take = () => event.preventDefault();

    if (mod && !event.altKey && event.key === '.') {
      take();
      notebook.toggleFold(day, id);
      return;
    }
    if (mod && !event.shiftKey && !event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      take();
      if (block.folded !== (event.key === 'ArrowUp')) notebook.toggleFold(day, id);
      return;
    }
    if (event.altKey && event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      take();
      focus(notebook.move(day, id, event.key === 'ArrowUp' ? 'up' : 'down', start));
      return;
    }
    const mark = formatShortcut(event);
    if (mark) {
      take();
      apply(element, toggleMark(element.textContent ?? '', start, end, mark));
      return;
    }
    if (sharedKey(event, controls)) return;
    // Ctrl+Enter: a plain Block becomes a Todo; a Todo is ticked or unticked.
    if (event.key === 'Enter' && mod && !event.altKey && !event.shiftKey) {
      take();
      if (block.todo) notebook.tick(day, id);
      else focus(notebook.makeTodo(day, id, start));
      return;
    }
    if (event.key === 'Enter' && !mod && !event.altKey) {
      take();
      if (event.shiftKey) document.execCommand('insertText', false, '\n');
      else focus(notebook.enter(day, id, start, end));
      return;
    }
    if (event.key === 'Tab' && !mod && !event.altKey) {
      take();
      focus(event.shiftKey ? notebook.outdent(day, id, start) : notebook.indent(day, id, start));
      return;
    }
    // Text never joins onto an image Block, nor an image onto text: the caret goes to the image instead.
    const imageNext = (step: 1 | -1) => {
      const next = neighbour(element, step);
      return next?.dataset.image !== undefined ? next : undefined;
    };
    if (event.key === 'Backspace' && !mod && start === 0 && end === 0) {
      take();
      // A styled line becomes a plain line first (a Todo loses its checkbox).
      const plain = notebook.unstyle(day, id);
      if (plain) {
        focus(plain);
        return;
      }
      const image = block.text ? imageNext(-1) : undefined;
      if (image) image.focus();
      else focus(notebook.removeBackward(day, id));
      return;
    }
    const length = (element.textContent ?? '').length;
    if (event.key === 'Delete' && !mod && start === length && end === length) {
      take();
      const image = imageNext(1);
      if (image) image.focus();
      else focus(notebook.joinNext(day, id));
    }
  };

  const editor = (
    // biome-ignore lint/a11y/useSemanticElements: a Block's text is a contenteditable, not an input
    <div
      ref={ref}
      className="n-content"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label="Block"
      tabIndex={0}
      spellCheck={false}
      data-block-text=""
      data-block-id={block.id}
      onInput={(event) => {
        const element = event.currentTarget;
        const text = element.textContent ?? '';
        if (!(event.nativeEvent as InputEvent).isComposing) renderBlockText(element, text, label);
        // `[ ] ` typed at the start makes the Block a Todo, and `- `, `1. ` or `## ` give it a style:
        // the mark goes, and the caret stays put.
        focus(notebook.type(day, block.id, text, selectionIn(element)[0]));
        tags.onInput(element);
        links.afterInput(element);
      }}
      onCompositionEnd={(event) =>
        renderBlockText(event.currentTarget, event.currentTarget.textContent ?? '', label)
      }
      onKeyDown={onKeyDown}
      onKeyUp={links.onKeyUp}
      onPaste={(event) => {
        const images = imageFiles(event.clipboardData);
        if (!images.length) return pasteText(event, (edit) => apply(event.currentTarget, edit));
        event.preventDefault();
        attach(images);
      }}
      onDrop={(event) => {
        event.preventDefault();
        const images = imageFiles(event.dataTransfer);
        if (images.length) attach(images);
      }}
      onMouseDown={(event) => {
        if (links.onMouseDown(event) || linkClicked(event)) event.preventDefault();
      }}
      onClick={(event) => {
        if (links.onClick(event)) return;
        const href = linkClicked(event);
        if (href) openBlockLink(href);
      }}
      onBlur={() => {
        tags.close();
        links.close();
        void notebook.flush();
      }}
    />
  );
  return (
    <>
      {editor}
      {tags.popup}
      {links.picker}
    </>
  );
});

interface BlockViewProps {
  day: string;
  block: Block;
  /** How far in it is drawn: list items and a quote's lines go in a step, other lines don't. */
  depth: number;
  tree: Map<string | null, Block[]>;
  /** Each Block's number on the sheet ("001"). */
  numbers: Map<string, string>;
  /** Each numbered item's number in its list. */
  ordinals: Map<string, number>;
  /** Whether it is inside a quote (a meeting's), which draws the quote's bar. */
  quoted: boolean;
  outline: Outline;
  projectView?: ProjectView;
}

function BlockView(props: BlockViewProps) {
  const { day, block, depth, tree, numbers, ordinals, quoted, outline, projectView } = props;
  const { notebook, focus, projects, sendToLinear } = useControls();
  // Under the Project filter, Blocks outside it (and not above one in it) aren't shown.
  const children = (tree.get(block.id) ?? []).filter((child) => !projectView?.hidden.has(child.id));
  const filing = projectView?.filings.get(block.id) ?? null;
  const ownProject = !!projectView && isOwnFiling(filing);
  const hasKids = children.length > 0;
  const folded = hasKids && block.folded;
  const wasFolded = useRef(folded);
  const opening = wasFolded.current && !folded;
  useEffect(() => {
    wasFolded.current = folded;
  }, [folded]);

  const fold = () => {
    if (hasKids) notebook.toggleFold(day, block.id);
    else focus({ id: block.id, offset: block.text.length });
  };

  const image = imageAttachmentOf(block.text);
  const meeting = meetingChipEventId(block.text);
  const style = styleOf(block);
  // A meeting chip, or a quote line outside one, starts a quote: its bar runs down its lines.
  const quoteStarts = !quoted && (!!meeting || style === 'quote');
  // Only list items, Todos and a quote's lines take the lines under them in a step, as Markdown nests;
  // under a heading or a plain line they follow at its own depth.
  const nests = isListItem(block) || style === 'todo' || !!block.todo || style === 'quote' || !!meeting;
  return (
    <div
      className={cn(
        'n-blk',
        hasKids && 'has-kids',
        folded && 'folded',
        block.todo && 'todo',
        block.todo?.done && 'done',
        quoteStarts && 'quote',
        projectView?.dimmed.has(block.id) && 'dim',
      )}
      data-block={block.id}
      data-style={style}
      data-heading={headingOf(style) || headingLevel(block.text) || undefined}
      data-image={image ? '' : undefined}
    >
      <div className={cn('n-row', ownProject && 'has-badge')} style={{ '--d': depth } as CSSProperties}>
        <span className="n-bn" aria-hidden="true">
          {numbers.get(block.id)}
        </span>
        {projects && projectView && (
          <BlockMargin
            filing={filing}
            own={ownProject}
            label={block.text}
            onPick={(anchor) => projects.pick(day, block, filing, anchor)}
          />
        )}
        {block.todo && <TodoCheck notebook={notebook} day={day} block={block} />}
        <button
          type="button"
          className="n-bullet"
          tabIndex={-1}
          title={hasKids ? (folded ? 'Click to unfold' : 'Click to fold') : undefined}
          aria-label={hasKids ? (folded ? 'Unfold' : 'Fold') : 'Go to Block'}
          aria-expanded={hasKids ? !folded : undefined}
          onMouseDown={(event) => event.preventDefault()}
          onClick={fold}
        >
          {/* A bullet's dot, a numbered item's number; any other line shows only its fold box. */}
          {style === 'numbered' ? <span className="n-ord">{ordinals.get(block.id) ?? 1}.</span> : <i />}
        </button>
        {image ? <BlockImage day={day} block={block} name={image} /> : <BlockText day={day} block={block} />}
        {folded && (
          <button
            type="button"
            className="n-hid"
            tabIndex={-1}
            title="Folded Blocks. Click to unfold."
            onMouseDown={(event) => event.preventDefault()}
            onClick={fold}
          >
            +{descendantCount(outline, block.id)}
          </button>
        )}
        <TodoTag block={block} />
        <BlockIssueChips blockId={block.id} />
        {sendToLinear && <BlockMenu label={block.text} onSendToLinear={() => sendToLinear(day, block)} />}
        {block.text.trim() && (
          <AskAres item={{ id: block.id, kind: 'block', title: block.text }} className="n-ares" />
        )}
      </div>
      {/* A meeting chip's Prep (#130): under its row, not a Block. */}
      {meeting && <MeetingPrep eventId={meeting} />}
      {hasKids && !folded && (
        <div className={cn('n-kids', !nests && 'flat', quoteStarts && 'quote', opening && 'opening')}>
          {children.map((child) => (
            <BlockView
              key={child.id}
              day={day}
              block={child}
              depth={nests ? depth + 1 : depth}
              tree={tree}
              numbers={numbers}
              ordinals={ordinals}
              quoted={quoted || quoteStarts}
              outline={outline}
              projectView={projectView}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// The row an empty Daily Note shows: typing in it makes the Daily Note's first Block.
function FirstBlock({ day, placeholder }: { day: string; placeholder: string }) {
  const controls = useControls();
  const { notebook, focus } = controls;
  const ref = useRef<HTMLDivElement>(null);
  useNativeInputGuard(ref, controls);

  // The first thing typed makes the Daily Note's first Block, and the caret carries on in it.
  const start = (element: HTMLElement) => {
    const text = element.textContent ?? '';
    if (!text) return;
    element.textContent = '';
    focus(notebook.begin(day, text));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || sharedKey(event, controls)) return;
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      if (event.key !== 'Enter' || event.shiftKey) return;
      const first = notebook.begin(day, '');
      focus(notebook.enter(day, first.id, 0, 0));
    }
  };

  return (
    <div className="n-blk">
      <div className="n-row" style={{ '--d': 0 } as CSSProperties}>
        <span className="n-bn" aria-hidden="true">
          001
        </span>
        {/* A plain line: no bullet. */}
        <span className="n-bullet" aria-hidden="true" />
        {/* biome-ignore lint/a11y/useSemanticElements: a Block's text is a contenteditable, not an input */}
        <div
          ref={ref}
          className="n-content"
          contentEditable="plaintext-only"
          suppressContentEditableWarning
          role="textbox"
          aria-label="Block"
          tabIndex={0}
          spellCheck={false}
          data-block-text=""
          data-ph={placeholder}
          onInput={(event) => {
            // Text being composed (an input method) becomes the first Block once it is committed.
            if (!(event.nativeEvent as InputEvent).isComposing) start(event.currentTarget);
          }}
          onCompositionEnd={(event) => start(event.currentTarget)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            const images = imageFiles(event.clipboardData);
            if (!images.length) return pastePlain(event);
            event.preventDefault();
            void readImages(images)
              .then((bytes) => notebook.attach(day, null, bytes))
              .then(focus);
          }}
          onDrop={(event) => {
            event.preventDefault();
            const images = imageFiles(event.dataTransfer);
            if (images.length)
              void readImages(images)
                .then((bytes) => notebook.attach(day, null, bytes))
                .then(focus);
          }}
        />
      </div>
    </div>
  );
}

export function OutlineView({
  day,
  outline,
  placeholder,
  projectView,
}: {
  day: string;
  outline: Outline;
  placeholder: string;
  /** Each Block's Project and the Project filter, where Blocks have Projects. */
  projectView?: ProjectView;
}) {
  const tree = useMemo(() => treeOf(outline), [outline]);
  const numbers = useMemo(() => blockNumbers(outline), [outline]);
  const ordinals = useMemo(() => listNumbers(tree), [tree]);
  const top = (tree.get(null) ?? []).filter((block) => !projectView?.hidden.has(block.id));
  return (
    <div className="n-outline">
      {!tree.get(null)?.length ? (
        <FirstBlock day={day} placeholder={placeholder} />
      ) : (
        top.map((block) => (
          <BlockView
            key={block.id}
            day={day}
            block={block}
            depth={0}
            tree={tree}
            numbers={numbers}
            ordinals={ordinals}
            quoted={false}
            outline={outline}
            projectView={projectView}
          />
        ))
      )}
    </div>
  );
}
