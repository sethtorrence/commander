/*
  The shortcut layer: every keyboard shortcut in Commander is registered here, and one keydown
  listener (ShortcutProvider) hands each key press to `handle`. The `?` cheat sheet reads `list()`.

  Rules every shortcut gets for free:
  - Keys typed as text (one character, no Ctrl/Alt/Meta) never fire while the caret is in a text
    field, select or editor (contenteditable, role=textbox). Chords and named keys (Ctrl+K, Escape)
    fire there only with `inFields: true`; a typed key can't ask for that.
  - Keys pressed inside a dialog stay with the dialog unless the shortcut sets `inDialogs: true`.
  - A shortcut with a `scope` runs only while that scope is active. The frame activates the open
    Section's scope (its id, e.g. "todos"), so a Section's own keys work only while it is shown.
    An active scope's shortcut wins over an app-wide one on the same key.
  - Registering a key that is already taken in the same scope throws, so clashes show up at once.

  In React, register through `useShortcuts` (shortcuts/react.tsx): inside a Section it fills in the
  scope and group by itself, and it unregisters when the component goes away.
*/

export interface Shortcut {
  /** The key as `KeyboardEvent.key` names it, with modifiers first: "3", "?", "x", "Escape", "Ctrl+K". */
  keys: string;
  /** What it does, for the cheat sheet: "Todos", "Tick a Todo". */
  label: string;
  /** The cheat sheet heading it is listed under: "Sections", "General", or a Section's name. */
  group: string;
  /** Runs only while this scope is active (a Section's id, "settings"). App-wide when left out. */
  scope?: string;
  /** Also runs while typing in a field. Only for chords and named keys. */
  inFields?: boolean;
  /** Also runs when the key is pressed inside a dialog. */
  inDialogs?: boolean;
  /** Runs only while this holds; otherwise the key is left to other shortcuts and the page. */
  when?: () => boolean;
  run: (event: KeyboardEvent) => void;
}

/** A shortcut as the cheat sheet shows it. */
export interface ListedShortcut {
  /** The key caps to draw, e.g. ["Ctrl", "K"]. */
  keys: string[];
  label: string;
  group: string;
  scope: string | undefined;
  /** Whether it works right now (app-wide, or its scope is active). */
  active: boolean;
}

export interface ShortcutRegistry {
  /** Adds a shortcut; returns the function that removes it. */
  register(shortcut: Shortcut): () => void;
  /** The scopes whose shortcuts run, e.g. the open Section's id. Replaces the previous set. */
  setActiveScopes(scopes: Iterable<string>): void;
  /** Runs the shortcut for this key press, if any. Returns whether one ran (and prevents the default). */
  handle(event: KeyboardEvent): boolean;
  /** Every registered shortcut in registration order. The same array until something changes. */
  list(): readonly ListedShortcut[];
  /** Called after any change to `list()`. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

// Input types that take no typing, so keys pressed on them are still shortcuts.
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file']);

/** Whether keys pressed here are typing: text fields, selects, and editors (contenteditable, role=textbox). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return !!target.closest(
    '[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"]',
  );
}

const inDialog = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest('[role="dialog"], [role="alertdialog"]');

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
type Modifier = (typeof MODIFIERS)[number];

// One spelling per chord: "Ctrl+Shift+k", "?", "Escape". Letters are lowercase. Shift only counts
// for named keys and alongside Ctrl, Alt or Meta: on its own it has already changed the key
// (Shift+/ arrives as "?").
function chord(modifiers: ReadonlySet<Modifier>, key: string): string {
  const printable = key.length === 1;
  const withOthers = modifiers.has('Ctrl') || modifiers.has('Alt') || modifiers.has('Meta');
  const held = MODIFIERS.filter((m) => modifiers.has(m) && (m !== 'Shift' || !printable || withOthers));
  return [...held, printable ? key.toLowerCase() : key].join('+');
}

function splitKeys(keys: string): { modifiers: Modifier[]; key: string } {
  // "Ctrl++" and "+" name the plus key itself.
  const plus = keys.endsWith('+');
  const parts = (plus ? keys.slice(0, -1) : keys).split('+').filter(Boolean);
  const key = plus ? '+' : (parts.pop() ?? '');
  const modifiers = parts.filter((part): part is Modifier => (MODIFIERS as readonly string[]).includes(part));
  if (!key || modifiers.length !== parts.length) throw new Error(`Can't read the keys "${keys}"`);
  return { modifiers, key };
}

function chordOfEvent(event: KeyboardEvent): string {
  const held = new Set<Modifier>();
  if (event.ctrlKey) held.add('Ctrl');
  if (event.altKey) held.add('Alt');
  if (event.shiftKey) held.add('Shift');
  if (event.metaKey) held.add('Meta');
  return chord(held, event.key);
}

// A key typed as text: one character, with no Ctrl, Alt or Meta (Shift is already folded in).
const isTypedKey = (chord: string) => chord.length === 1;

type Entry = Shortcut & { chord: string; caps: string[] };

export function createShortcutRegistry(): ShortcutRegistry {
  let entries: Entry[] = [];
  let activeScopes = new Set<string>();
  let listed: readonly ListedShortcut[] | null = null;
  const listeners = new Set<() => void>();

  const changed = () => {
    listed = null;
    for (const listener of listeners) listener();
  };
  const isActive = (entry: Entry) => entry.scope === undefined || activeScopes.has(entry.scope);

  return {
    register(shortcut) {
      const { modifiers, key } = splitKeys(shortcut.keys);
      const entry: Entry = {
        ...shortcut,
        chord: chord(new Set(modifiers), key),
        caps: [...modifiers, key.length === 1 ? key.toUpperCase() : key],
      };
      if (entry.inFields && isTypedKey(entry.chord))
        throw new Error(
          `"${shortcut.keys}" (${shortcut.label}) can't run in fields: it would swallow typing`,
        );
      const taken = entries.find((e) => e.chord === entry.chord && e.scope === entry.scope);
      if (taken) throw new Error(`"${shortcut.keys}" is already ${taken.label} (${taken.group})`);
      entries = [...entries, entry];
      changed();
      return () => {
        if (!entries.includes(entry)) return;
        entries = entries.filter((e) => e !== entry);
        changed();
      };
    },

    setActiveScopes(scopes) {
      activeScopes = new Set(scopes);
      changed();
    },

    handle(event) {
      if (event.defaultPrevented || event.isComposing) return false;
      const pressed = chordOfEvent(event);
      const typing = isTypingTarget(event.target);
      const dialog = inDialog(event.target);
      const candidates = entries.filter(
        (e) =>
          e.chord === pressed &&
          isActive(e) &&
          (!typing || e.inFields) &&
          (!dialog || e.inDialogs) &&
          (e.when?.() ?? true),
      );
      const match = candidates.find((e) => e.scope !== undefined) ?? candidates[0];
      if (!match) return false;
      event.preventDefault();
      match.run(event);
      return true;
    },

    list() {
      listed ??= entries.map((e) => ({
        keys: e.caps,
        label: e.label,
        group: e.group,
        scope: e.scope,
        active: isActive(e),
      }));
      return listed;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
