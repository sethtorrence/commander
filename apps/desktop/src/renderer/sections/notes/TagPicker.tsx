import { type Project, tagBeingTyped } from '@commander/domain';
import { Badge, cn, usePortalContainer } from '@commander/ui';
import { type KeyboardEvent, type ReactNode, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { selectionIn } from './caret';

/*
  The `#` picker in a Block: typing `#` and a letter offers the active Projects whose code or name
  starts with what is typed, until a whole code is typed. `↑`/`↓` move, `Enter` or `Tab` puts the
  code in (`#LT `), `Esc` closes and leaves the typing as it is. Choosing only completes the text:
  the shorthand itself is what files the Block (block-projects.ts), so `#lt` typed out in full works
  the same without the picker.
*/

interface Open {
  /** Where `#` is, and the caret just after the letters typed. */
  start: number;
  caret: number;
  choices: Project[];
  active: number;
  /** Where to draw it: under the caret. */
  left: number;
  top: number;
}

/** The active Projects a `#` and these letters could mean: by code, then by name. */
export function tagChoices(projects: readonly Project[], query: string): Project[] {
  const q = query.toLowerCase();
  const byCode = projects.filter((p) => p.code.toLowerCase().startsWith(q));
  const byName = projects.filter((p) => !byCode.includes(p) && p.name.toLowerCase().startsWith(q));
  return [...byCode, ...byName];
}

function caretBox(): { left: number; top: number } | null {
  const selection = getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  return rect ? { left: rect.left, top: rect.bottom } : null;
}

export interface TagPicker {
  /** After each input: opens, narrows or closes the picker for what is before the caret. */
  onInput(element: HTMLElement): void;
  /** Takes the keys it handles while open; returns whether it took this one. */
  onKeyDown(event: KeyboardEvent<HTMLElement>): boolean;
  close(): void;
  popup: ReactNode;
}

/**
 * The `#` picker for one Block. `complete` writes the Block's new text with the caret at an offset,
 * as typing would.
 */
export function useTagPicker(
  projects: readonly Project[] | undefined,
  complete: (text: string, caret: number) => void,
): TagPicker {
  const [open, setOpen] = useState<Open | null>(null);
  const portal = usePortalContainer() ?? (typeof document === 'undefined' ? null : document.body);
  const close = useCallback(() => setOpen(null), []);

  const onInput = (element: HTMLElement) => {
    if (!projects?.length) return;
    const text = element.textContent ?? '';
    const [caret, end] = selectionIn(element);
    const typed = caret === end ? tagBeingTyped(text, caret) : null;
    const choices = typed ? tagChoices(projects, typed.query) : [];
    // A code typed in full needs nothing completing: Enter goes back to making a new Block.
    const whole = typed && projects.some((p) => p.code.toLowerCase() === typed.query.toLowerCase());
    if (!typed || !choices.length || whole) {
      setOpen(null);
      return;
    }
    const box = caretBox() ?? element.getBoundingClientRect();
    setOpen((was) => ({
      start: typed.start,
      caret,
      choices,
      active: was && was.start === typed.start ? Math.min(was.active, choices.length - 1) : 0,
      left: 'left' in box ? box.left : 0,
      top: ('top' in box ? box.top : 0) + 4,
    }));
  };

  const choose = (element: HTMLElement, project: Project | undefined) => {
    if (!open || !project) return;
    const text = element.textContent ?? '';
    const after = text.slice(open.caret);
    const inserted = `#${project.code}${after.startsWith(' ') ? '' : ' '}`;
    setOpen(null);
    complete(
      text.slice(0, open.start) + inserted + after,
      open.start + inserted.length + (after.startsWith(' ') ? 1 : 0),
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!open || event.ctrlKey || event.metaKey || event.altKey) return false;
    const count = open.choices.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setOpen({ ...open, active: (open.active + step + count) % count });
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      choose(event.currentTarget, open.choices[open.active]);
    } else if (event.key === 'Escape') {
      setOpen(null);
    } else return false;
    event.preventDefault();
    // Esc here closes the picker, not the Block (the window's Esc leaves the field).
    event.stopPropagation();
    return true;
  };

  const popup =
    open && portal
      ? createPortal(
          <div
            role="listbox"
            aria-label="Projects"
            data-testid="tag-picker"
            className="fixed z-45 w-[248px] border border-ink bg-sheet text-text"
            style={{ left: Math.min(open.left, window.innerWidth - 260), top: open.top }}
          >
            <div className="flex h-6 items-center justify-between bg-ink px-2.5 font-mono text-tiny leading-none font-semibold uppercase tracking-label text-sheet">
              <span>Project</span>
              <span className="font-medium opacity-70">↵ files · Esc</span>
            </div>
            {open.choices.map((project, index) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard chooses from the Block itself
              <div
                key={project.id}
                role="option"
                aria-selected={index === open.active}
                tabIndex={-1}
                // The caret stays in the Block.
                onMouseDown={(event) => event.preventDefault()}
                onPointerEnter={() => setOpen({ ...open, active: index })}
                onClick={() => {
                  const element = document.activeElement;
                  if (element instanceof HTMLElement) choose(element, project);
                }}
                className={cn(
                  'grid h-8 cursor-pointer grid-cols-[30px_minmax(0,1fr)] items-center gap-2 border-b border-line2 px-2.5 last:border-b-0',
                  index === open.active && 'bg-raise',
                )}
              >
                <Badge code={project.code} accent={project.accent} project={project.name} />
                <span className="truncate font-sans text-note leading-none font-semibold text-ink">
                  {project.name}
                </span>
              </div>
            ))}
          </div>,
          portal,
        )
      : null;

  return { onInput, onKeyDown, close, popup };
}
