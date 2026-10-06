import { type Item, injectionWarningText, refusalText } from '@commander/domain';
import { RefusalNote, toast, WarningMark } from '@commander/ui';
import { createContext, useContext } from 'react';
import type { ItemStoreClient } from '../item-store/client';

/** What the warning mark can do where it is shown (#201): Not an instruction. */
export interface WarningActions {
  /** Clears the Item's mark (a Todo's: the mark of the Item behind it), as the User's correction. */
  clear(item: Item): void;
}

const WarningActionsContext = createContext<WarningActions | null>(null);

/** Gives every warning mark below it Not an instruction. Without it, a mark only says what it is. */
export const WarningActionsProvider = WarningActionsContext.Provider;

const report = (error: unknown) => toast(error instanceof Error ? error.message : String(error));

/**
 * Not an instruction through the window's Item store channel: the Core clears the mark (and its
 * Update line), every open view catches up, and the toast's Undo brings the mark back.
 */
export function warningActionsIn(itemStore: ItemStoreClient): WarningActions {
  return {
    clear(item) {
      itemStore({ op: 'clear-injection-warning', itemId: item.id }).then(
        (entry) =>
          toast(`Not an instruction: ${item.title}`, {
            action: {
              label: 'Undo',
              onClick: () =>
                void itemStore({ op: 'record', action: { type: 'undo', entryId: entry.id } }).catch(report),
            },
          }),
        report,
      );
    },
  };
}

/**
 * An Item's warning mark (#69), when it (or, for a Todo, the Item behind it) holds instructions
 * aimed at Ares: the one shared WarningMark, worded for the Item's kind, offering Not an instruction
 * where it is (#201). And the small note on an Item Ares sent to no model because it holds one of
 * the User's keys or sign-in tokens (#201). Nothing otherwise.
 */
export function ItemWarning({
  item,
  variant = 'row',
  className,
}: {
  item: Item;
  variant?: 'row' | 'pane';
  className?: string;
}) {
  const actions = useContext(WarningActionsContext);
  if (!item.injectionWarning && !item.refusal) return null;
  return (
    <>
      {item.injectionWarning && (
        <WarningMark
          message={injectionWarningText(item.kind)}
          variant={variant}
          className={className}
          {...(actions && { onClear: () => actions.clear(item) })}
        />
      )}
      {item.refusal && (
        <RefusalNote message={refusalText(item.kind)} variant={variant} className={className} />
      )}
    </>
  );
}
