import '../../links/links.css';
import { type BlockLinkTarget, blockLinksIn } from '@commander/domain';
import { Badge, cn } from '@commander/ui';
import { type KeyboardEvent, type MouseEvent, useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { chipLabel, type LinkQuery, linkQueryAt } from '../../links/block-text';
import {
  type CandidateGroup,
  dayTargets,
  eventTargets,
  type LinkCandidate,
  type LinkTargetProvider,
  projectTargets,
  searchTargets,
} from '../../links/link-targets';
import type { EventLookup } from '../../links/use-events';
import { useProjectsIfAny } from '../../projects/context';
import { openBlockLink } from './block-editor';
import { placeCaret, selectionIn } from './caret';
import { chipAt, type LabelChip } from './chips';
import type { Notebook } from './notebook';
import type { Block, Caret } from './outline';

/*
  `[[` links in the outliner. Typing `[[` opens the picker over the link-target providers (days,
  Projects and calendar events); choosing one puts a chip in the Block (the Notebook's `link`), which
  the Item store makes a refers-to Link. A chip is drawn over its token (chips.ts, through markdown.ts),
  goes whole with Backspace or Delete beside it (the Notebook's `unlink`), and clicking it follows it.
  An event's chip is its live card (#128), whose Join opens the online meeting in the browser.
*/

/** What the outline needs for `[[` links: where the picker looks, chip labels, and following one. */
export interface OutlineLinks {
  providers: readonly LinkTargetProvider[];
  label: LabelChip;
  /** Follows a chip: a day's sheet, a Project's page. Absent where chips don't go anywhere. */
  open?(target: BlockLinkTarget): void;
}

// Without OutlineLinks (a test, say): chips still draw, from their tokens alone.
const plainLabel: LabelChip = (target) =>
  target.type === 'day'
    ? { text: target.day, title: target.day }
    : target.type === 'event'
      ? { text: 'A meeting', title: 'A calendar event' }
      : { text: 'Project', title: 'A Project' };

/**
 * `[[` links for the Notes Section or the daily template: days (around `today`), Projects and, given
 * `events`, calendar events (whose chips are live meeting cards), and following a chip with `open`.
 * `days: false` leaves days out (the template has no day of its own).
 */
export function useOutlineLinks(
  today: string,
  open?: (target: BlockLinkTarget) => void,
  { days = true, events }: { days?: boolean; events?: EventLookup } = {},
): OutlineLinks {
  const projects = useProjectsIfAny();
  const all = useMemo(() => (projects ? [...projects.projects, ...projects.archived] : []), [projects]);
  return useMemo(() => {
    const byId = new Map(all.map((project) => [project.id, project]));
    const providers = [
      ...(days ? [dayTargets(today)] : []),
      projectTargets(all),
      ...(events ? [eventTargets(events.offered, today)] : []),
    ];
    const label: LabelChip = (target, place) =>
      chipLabel(
        target,
        { today, projectById: (id) => byId.get(id), eventById: (id) => events?.byId.get(id) },
        place,
      );
    return { providers, label, open };
  }, [all, today, open, days, events]);
}

interface PickerState {
  at: LinkQuery;
  groups: CandidateGroup[];
  index: number;
  /** Where the caret was, to put the picker under it. */
  left: number;
  top: number;
}

function caretBox(element: HTMLElement): { left: number; top: number } {
  const range = getSelection()?.rangeCount ? getSelection()?.getRangeAt(0).cloneRange() : null;
  const rects = typeof range?.getClientRects === 'function' ? range.getClientRects() : null;
  const rect = rects?.[0] ?? element.getBoundingClientRect();
  return { left: rect.left, top: rect.bottom };
}

const candidatesOf = (groups: CandidateGroup[]) => groups.flatMap((group) => group.candidates);

// Whether everything in the text after `offset` is `[[` tokens and spaces.
const onlyLinksAfter = (text: string, offset: number) => {
  let rest = text.slice(offset);
  for (const token of blockLinksIn(rest).reverse()) rest = rest.slice(0, token.start) + rest.slice(token.end);
  return rest.trim() === '' && rest.length < text.length - offset;
};

/**
 * Wires `[[` links into one Block's editable text: draws its chips, runs the picker, removes chips
 * whole and follows them. BlockText calls the handlers first and stops when they say they handled it.
 */
export function useBlockLinks({
  day,
  block,
  notebook,
  focus,
  links,
}: {
  day: string;
  block: Block;
  notebook: Notebook;
  focus(caret: Caret | null): void;
  links: OutlineLinks | undefined;
}) {
  const [picker, setPicker] = useState<PickerState | null>(null);
  // The `[[` the User closed the picker on, so it stays closed while they type on after it.
  const [dismissed, setDismissed] = useState<number | null>(null);
  // Chips read from this Block's day: a meeting moved to another day says so.
  const base = links?.label ?? plainLabel;
  const label = useMemo<LabelChip>(() => (target) => base(target, { day }), [base, day]);

  const close = useCallback(() => setPicker(null), []);

  /** After typing: opens, narrows or closes the picker for the `[[` the caret is in. */
  const afterInput = (element: HTMLElement) => {
    if (!links) return;
    const text = element.textContent ?? '';
    const at = linkQueryAt(text, selectionIn(element)[0]);
    if (!at || at.start === dismissed) {
      if (!at) setDismissed(null);
      setPicker(null);
      return;
    }
    const groups = searchTargets(links.providers, at.query);
    setPicker({ at, groups, index: 0, ...caretBox(element) });
  };

  const choose = (candidate: LinkCandidate | undefined) => {
    if (!picker || !candidate) return;
    setPicker(null);
    focus(notebook.link(day, block.id, picker.at, candidate.target));
  };

  /** Keys for the picker and for chips. Returns true when it handled the key. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): boolean => {
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    if (picker) {
      const all = candidatesOf(picker.groups);
      const step = (by: number) =>
        all.length && setPicker({ ...picker, index: (picker.index + by + all.length) % all.length });
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        step(event.key === 'ArrowDown' ? 1 : -1);
        return true;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && plain && !event.shiftKey && all.length) {
        event.preventDefault();
        choose(all[picker.index]);
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(picker.at.start);
        setPicker(null);
        return true;
      }
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && plain) {
      const [start, end] = selectionIn(event.currentTarget);
      if (start !== end) return false;
      const caret = notebook.unlink(day, block.id, start, event.key === 'Backspace' ? 'backward' : 'forward');
      if (!caret) return false;
      event.preventDefault();
      setPicker(null);
      focus(caret);
      return true;
    }
    return false;
  };

  // Moving the caret along the text narrows or closes the picker, as typing does. End can stop short
  // of chips that end the line (the browser's line end skips non-editable elements): only chips left
  // after the caret means it was meant to go past them.
  const onKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (event.key === 'End' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      const text = element.textContent ?? '';
      const [start, end] = selectionIn(element);
      if (start === end && start < text.length && onlyLinksAfter(text, start))
        placeCaret(element, text.length);
    }
    if (picker && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) afterInput(element);
  };

  // A press on a chip is for following it, not for putting the caret there: true when it is one.
  const onMouseDown = (event: MouseEvent) => !!chipAt(event.target);

  /** A click on a chip follows it. Returns true when the click was on one. */
  const onClick = (event: MouseEvent<HTMLElement>): boolean => {
    // A meeting card's Join opens the online meeting in the browser.
    const join = event.target instanceof Element ? event.target.closest<HTMLElement>('.n-meet-join') : null;
    if (join?.dataset.join) {
      event.preventDefault();
      openBlockLink(join.dataset.join);
      return true;
    }
    const chip = chipAt(event.target);
    const target = chip?.dataset.token && blockLinksIn(chip.dataset.token)[0]?.target;
    if (!target) {
      // A click past chips that end the text can land before them (as End can): put it after.
      const element = event.currentTarget;
      const text = element.textContent ?? '';
      const [start, end] = selectionIn(element);
      const chips = element.querySelectorAll('.n-chip');
      const last = chips[chips.length - 1];
      const past = last && event.clientX > last.getBoundingClientRect().right;
      if (past && start === end && start < text.length && onlyLinksAfter(text, start))
        placeCaret(element, text.length);
      return false;
    }
    event.preventDefault();
    links?.open?.(target);
    return true;
  };

  const view = picker && (
    <LinkPicker state={picker} onChoose={choose} onHover={(index) => setPicker({ ...picker, index })} />
  );

  return { label, afterInput, onKeyDown, onKeyUp, onMouseDown, onClick, close, picker: view };
}

/** The `[[` picker (.acpop): each provider's matches in a group, the chosen one inked. */
function LinkPicker({
  state,
  onChoose,
  onHover,
}: {
  state: PickerState;
  onChoose(candidate: LinkCandidate): void;
  onHover(index: number): void;
}) {
  const left = Math.max(8, Math.min(state.left - 8, window.innerWidth - 372));
  let index = -1;
  return createPortal(
    <div
      className="n-acpop"
      role="listbox"
      aria-label="Link to"
      data-testid="link-picker"
      style={{ left, top: state.top + 8 }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="ah">
        Link to · {state.at.query ? `“${state.at.query}”` : 'a day, a Project or an event'}
      </div>
      {state.groups.length === 0 && (
        <div className="none">Nothing matches. Try a date, “today”, a Project or a meeting.</div>
      )}
      {state.groups.map((group) => (
        // biome-ignore lint/a11y/useSemanticElements: a group of options in a listbox
        <div key={group.provider.id} role="group" aria-label={group.provider.label}>
          <div className="gh">{group.provider.label}</div>
          {group.candidates.map((candidate) => {
            index += 1;
            const mine = index;
            const selected = mine === state.index;
            return (
              // biome-ignore lint/a11y/useFocusableInteractive: the caret stays in the Block; keys move the choice
              // biome-ignore lint/a11y/useKeyWithClickEvents: chosen with Enter from the Block
              <div
                key={candidate.key}
                role="option"
                aria-selected={selected}
                className={cn('opt', selected && 'sel')}
                onMouseEnter={() => onHover(mine)}
                onClick={() => onChoose(candidate)}
              >
                {candidate.project ? (
                  <Badge
                    code={candidate.project.code}
                    accent={candidate.project.accent}
                    project={candidate.project.name}
                  />
                ) : (
                  <span className="pg">[[</span>
                )}
                <span className="min-w-0 truncate">{candidate.label}</span>
                {candidate.hint && <span className="hint">{candidate.hint}</span>}
              </div>
            );
          })}
        </div>
      ))}
    </div>,
    document.body,
  );
}
