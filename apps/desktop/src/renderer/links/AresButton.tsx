import type { Item } from '@commander/domain';
import { AresButton } from '@commander/ui';
import { createContext, useContext } from 'react';
import type { ShortcutSpec } from '../shortcuts/react';

/*
  The Ares button on an Item (#193, decisions #24, #10, #29): the AI mark on Item rows and detail
  panes in every Section. Pressing it (or `a` on the focused Item) opens a small pop-up beside the
  Item, starting a new Conversation with that Item in it (sections/ares/AresPopup.tsx, which gives
  every button below it what to open). Adding it to a row or pane is one line:

    <AskAres item={issue} />            on a row: the mark alone
    <AskAres item={issue} variant="pane" />   on a detail pane: the mark and "Ask Ares"

  and `a` is one entry in the Section's shortcuts, for the Item the Section has focused:

    const aresKey = useAresKey(selected);
    useShortcuts([..., aresKey]);

  Without the pop-up above it (a component test of a Section), the button draws nothing and `a`
  does nothing.
*/

/** What the pop-up needs of an Item: which it is, and how to name it. */
export type AresTarget = Pick<Item, 'id' | 'kind' | 'title'>;

/** What the Ares button can do where it is shown. */
export interface AresActions {
  /** Opens the pop-up on an Item, beside `anchor` (the button pressed) when given. */
  open(target: AresTarget, anchor?: HTMLElement | null): void;
}

const AresContext = createContext<AresActions | null>(null);

/** Gives every Ares button below it its pop-up (sections/ares/AresPopup.tsx). */
export const AresProvider = AresContext.Provider;

/** The pop-up's opener, or null outside it. */
export const useAres = () => useContext(AresContext);

/** How the button names what it does, for its accessible name. */
export const askAresLabel = (target: Pick<AresTarget, 'title'>) =>
  `Ask Ares about ${target.title.trim() || 'this'}`;

/**
 * The Item's Ares button where it is shown, if it is: the pane's when its detail is open, else its
 * row's. The pop-up opened with `a` stands beside it.
 */
export function aresButtonFor(itemId: string): HTMLElement | null {
  const shown = [
    ...document.querySelectorAll<HTMLElement>(`[data-ares-item="${CSS.escape(itemId)}"]`),
  ].filter((element) => element.getClientRects().length > 0);
  return shown.find((element) => element.dataset.aresVariant === 'pane') ?? shown[0] ?? null;
}

/** The Ares button on an Item's row (the mark alone) or detail pane (the mark and "Ask Ares"). */
export function AskAres({
  item,
  variant = 'row',
  className,
}: {
  item: AresTarget;
  variant?: 'row' | 'pane';
  className?: string;
}) {
  const ares = useContext(AresContext);
  if (!ares) return null;
  return (
    <AresButton
      variant={variant}
      aria-label={askAresLabel(item)}
      title="Ask Ares about it (A)"
      data-ares-item={item.id}
      data-ares-variant={variant}
      data-testid="ares-button"
      className={className}
      // A row opens on a click: the button opens the pop-up instead, and leaves any caret where it is.
      onMouseDown={(event) => event.preventDefault()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        ares.open(item, event.currentTarget);
      }}
    />
  );
}

type Focused = AresTarget | null | undefined;

/**
 * `a`, the Ares key (#29), for a Section's shortcuts: the pop-up on the Item the Section has focused
 * (its selected row, or the one open in its pane; or, given a function, whatever it finds when the
 * key is pressed), listed in `?`. Nothing while none is.
 */
export function useAresKey(target: Focused | (() => Focused)): ShortcutSpec {
  const ares = useContext(AresContext);
  const focused = () => (typeof target === 'function' ? target() : target);
  return {
    keys: 'a',
    label: 'Ask Ares about it',
    when: () => !!ares && !!focused(),
    run: () => {
      const item = focused();
      if (ares && item) ares.open(item, aresButtonFor(item.id));
    },
  };
}
