import { type ComposeBody, isComposeLink } from '@commander/domain';
import { cn } from '@commander/ui';
import { type ClipboardEvent, type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { readEditor, writeEditor } from './rich-text';

/*
  The composer's body (#138): simple formatting (bold, italic, links and lists) in an editor whose
  contents are only ever the composer's model (rich-text.ts). Pasting and dropping text insert it as
  text; dropping files hands them to `onFiles` (attachments). Ctrl+B and Ctrl+I as everywhere.
*/

const toolButton =
  'h-7 min-w-7 cursor-pointer border-0 border-r border-line2 bg-transparent px-2 font-mono text-label font-semibold text-ink hover:bg-raise';

// The editor's formatting commands. execCommand is what contenteditable offers; what it makes is read
// back into the model, so nothing it adds beyond that survives.
const run = (command: string, value?: string) => {
  document.execCommand(command, false, value);
};

export function RichEditor({
  initial,
  onChange,
  onFiles,
  label,
  className,
  autoFocus = false,
}: {
  /** The body it starts with (read once). */
  initial: ComposeBody;
  onChange: (body: ComposeBody) => void;
  /** Files dropped on it, as attachments. */
  onFiles?: (files: File[]) => void;
  label: string;
  className?: string;
  autoFocus?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const saved = useRef<Range | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const first = useRef(initial);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    writeEditor(element, first.current);
    if (autoFocus) {
      element.focus();
      // The caret at the start, above the signature.
      const range = document.createRange();
      range.setStart(element, 0);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }
  }, [autoFocus]);

  const changed = () => {
    if (root.current) onChange(readEditor(root.current));
  };

  const insertText = (text: string) => {
    run('insertText', text);
    changed();
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    insertText(event.clipboardData.getData('text/plain'));
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = [...event.dataTransfer.files];
    event.preventDefault();
    if (files.length) onFiles?.(files);
    else {
      const text = event.dataTransfer.getData('text/plain');
      if (text) insertText(text);
    }
  };

  const keepSelection = () => {
    const selection = window.getSelection();
    saved.current = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  };
  const restoreSelection = () => {
    root.current?.focus();
    if (!saved.current) return;
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(saved.current);
  };

  const format = (command: string) => {
    root.current?.focus();
    run(command);
    changed();
  };

  const link = (href: string) => {
    const address = /^[^\s@:/]+@[^\s@]+$/.test(href.trim()) ? `mailto:${href.trim()}` : href.trim();
    setLinking(null);
    restoreSelection();
    if (!isComposeLink(address)) return;
    const selection = window.getSelection();
    if (selection?.isCollapsed) run('insertText', address);
    if (selection?.isCollapsed) {
      // What was typed becomes the link's text, selected so it is linked.
      const range = selection.getRangeAt(0);
      range.setStart(range.endContainer, Math.max(0, range.endOffset - address.length));
      selection.removeAllRanges();
      selection.addRange(range);
    }
    run('createLink', address);
    changed();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      keepSelection();
      setLinking('');
    }
  };

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div
        role="toolbar"
        aria-label="Formatting"
        className="flex flex-none items-stretch border-b border-line2"
      >
        {(
          [
            ['bold', 'Bold (Ctrl+B)', 'B'],
            ['italic', 'Italic (Ctrl+I)', 'I'],
            ['insertUnorderedList', 'Bulleted list', '•'],
            ['insertOrderedList', 'Numbered list', '1.'],
          ] as const
        ).map(([command, title, glyph]) => (
          <button
            key={command}
            type="button"
            title={title}
            aria-label={title}
            className={cn(toolButton, command === 'italic' && 'italic', command === 'bold' && 'font-bold')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => format(command)}
          >
            {glyph}
          </button>
        ))}
        <button
          type="button"
          title="Link (Ctrl+K)"
          aria-label="Link (Ctrl+K)"
          className={toolButton}
          onMouseDown={(event) => {
            event.preventDefault();
            keepSelection();
          }}
          onClick={() => setLinking('')}
        >
          Link
        </button>
        {linking !== null && (
          <form
            className="flex min-w-0 flex-1 items-center gap-2 px-2"
            onSubmit={(event) => {
              event.preventDefault();
              link(linking);
            }}
          >
            <input
              // biome-ignore lint/a11y/noAutofocus: the link's address is asked for at once
              autoFocus
              aria-label="Link address"
              placeholder="https://… or an email address"
              value={linking}
              onChange={(event) => setLinking(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setLinking(null);
                  restoreSelection();
                }
              }}
              className="h-6 min-w-0 flex-1 border border-line bg-sheet px-2 text-note text-ink outline-none focus:border-ink"
            />
          </form>
        )}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a contenteditable editor is the composer's body */}
      <div
        ref={root}
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        tabIndex={0}
        contentEditable
        suppressContentEditableWarning
        spellCheck
        data-testid="compose-body"
        onInput={changed}
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={(event) => event.preventDefault()}
        onKeyDown={onKeyDown}
        className="min-h-[160px] flex-1 overflow-y-auto px-4 py-3 text-[15px] leading-[1.6] text-text outline-none [&_[data-ares-link]]:bg-signal-focus [&_[data-ares-link]]:text-ink [&_[data-ares-link]]:outline-1 [&_[data-ares-link]]:outline-dashed [&_[data-ares-link]]:outline-ink [&_a]:text-ink [&_a]:underline [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-6"
      />
    </div>
  );
}
