import { type Item, injectionWarningText } from '@commander/domain';
import { WarningMark } from '@commander/ui';

/**
 * An Item's warning mark (#69), when it (or, for a Todo, the Item behind it) holds instructions
 * aimed at Ares: the one shared WarningMark, worded for the Item's kind. Nothing otherwise.
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
  if (!item.injectionWarning) return null;
  return <WarningMark message={injectionWarningText(item.kind)} variant={variant} className={className} />;
}
