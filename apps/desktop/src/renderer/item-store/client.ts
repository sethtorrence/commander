/**
 * The window's Item store channel (the preload bridge, `window.commander.itemStore`), or a stand-in
 * for tests (test-item-store.ts). Every action sent through it is recorded as the User's.
 */
export type ItemStoreClient = Window['commander']['itemStore'];
