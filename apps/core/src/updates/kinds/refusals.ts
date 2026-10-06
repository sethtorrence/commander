// The Update line about refusals (#201): Items Ares sent to no model because they hold one of the
// User's keys or sign-in tokens, grouped into one line when there are several. It names each Item,
// says nothing of it went to a model, and what to do. It never holds the secret, and it is kept in
// Commander's own words: its Items are exactly what must not be handed to a model, so the line is
// never sent to "Put Updates together".
import type { Item } from '@commander/domain';
import type { LineKind } from './types';
import { listed, namedWhere, nameOf, plural } from './words';

const HOLDS = 'what looks like one of your keys or sign-in tokens';

export const refusalLines: LineKind<'refusals'> = {
  name: 'Items Ares sent to no model, because they hold a key or token',
  template({ about, itemIds }, context) {
    const items = itemIds.map((itemId) => context.item(itemId)).filter((item): item is Item => item !== null);
    const [only] = items;
    if (only && items.length === 1) {
      return `I skipped ${namedWhere(only)}: it holds ${HOLDS}, so none of it went to a model. Nothing to do, though if that key is still in use, it may be worth changing it.`;
    }
    const count = items.length || about.entryIds.length;
    return `I skipped ${plural(count, 'item')} because they hold ${HOLDS}${items.length ? `: ${listed(items.map(nameOf))}` : ''}. None of them went to a model. Nothing to do, though if those keys are still in use, it may be worth changing them.`;
  },
  facts: ({ about, itemIds }) => [
    'What it is: Items Ares sent to no model, because they hold one of the User’s keys or sign-in tokens.',
    `How many: ${itemIds.length || about.entryIds.length}`,
  ],
  row: () => ({ state: 'Skipped: none of it went to a model', actions: ['open'] }),
  // The line counts its refusals by entry: dismissing one Item only takes it off the line.
  without: (about) => about,
  apart: true,
  guidance: '',
};
