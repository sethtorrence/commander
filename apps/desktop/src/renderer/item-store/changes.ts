/**
 * Word from the Core of which Items changed in the Item store, whichever Section (or, later, Ares or a
 * sync) changed them, so views showing those Items can catch up. Subscribing returns the function
 * that stops it. A stand-in for tests comes with the test Item store (test-item-store.ts).
 */
export type ItemChanges = (listener: (itemIds: string[]) => void) => () => void;

/** The window's feed of Item changes, from the Core's `items-changed` messages. */
export const itemChangesFromCore: ItemChanges = (listener) =>
  window.commander.onCoreMessage((message) => {
    if (message.type === 'items-changed') listener(message.itemIds);
  });
