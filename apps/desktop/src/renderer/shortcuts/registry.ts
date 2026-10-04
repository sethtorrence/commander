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
  - A sequence is keys pressed in turn, written with a space: "p 1" is p then 1. After its first
    key, the next key either finishes a sequence or cancels it (and does nothing else); the first
    key is forgotten after a pause. `pending()` is the first key while it waits, for hints on screen.
    A single key can't also start a sequence in the same scope.

  In React, register through `useShortcuts` (shortcuts/react.tsx): inside a Section it fills in the
  scope and group by itself, and it unregisters when the component goes away.
*/

export interface Shortcut {
  /**
   * The key as `KeyboardEvent.key` names it, with modifiers first: "3", "?", "x", "Escape", "Ctrl+K".
   * Keys pressed in turn are separated by a space: "p 1".
   */
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
  /** The key caps to draw, e.g. ["Ctrl", "K"], or each key of a sequence in turn: ["P", "1"]. */
  keys: string[];
  /** Whether the keys are pressed in turn rather than together. */
  sequence: boolean;
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
  /** The first key of a sequence while it waits for the next ("p"), or null. */
  pending(): string | null;
  /** Called after any change to `list()` or `pending()`. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** How long the first key of a sequence waits for the next. */
export const SEQUENCE_TIMEOUT_MS = 2400;

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

// One spelling per chord: "Ctrl+Shift+k", "Shift+u", "?", "Escape". Letters are lowercase. Shift
// counts for named keys, letters (Shift+U isn't U: Caps Lock alone still gives the letter) and
// alongside Ctrl, Alt or Meta; with any other printable key it has already changed the key (Shift+/
// arrives as "?").
const isLetter = (key: string) => key.length === 1 && key.toLowerCase() !== key.toUpperCase();

function chord(modifiers: ReadonlySet<Modifier>, key: string): string {
  const printable = key.length === 1;
  const withOthers = modifiers.has('Ctrl') || modifiers.has('Alt') || modifiers.has('Meta');
  const held = MODIFIERS.filter(
    (m) => modifiers.has(m) && (m !== 'Shift' || !printable || isLetter(key) || withOthers),
  );
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

// A key typed as text: one character, with no Ctrl, Alt or Meta (Shift folded in, or a capital).
const isTypedKey = (chord: string) => chord.length === 1 || /^Shift\+.$/.test(chord);

// A shortcut ready to match: `chords` is one chord, or each chord of a sequence in turn.
type Entry = Shortcut & { chords: string[]; caps: string[] };

function parseKeys(keys: string): Pick<Entry, 'chords' | 'caps'> {
  // A space between keys makes a sequence; the space key on its own is " ".
  const steps = keys.length > 1 && keys.includes(' ') ? keys.split(' ') : [keys];
  const parsed = steps.map(splitKeys);
  return {
    chords: parsed.map(({ modifiers, key }) => chord(new Set(modifiers), key)),
    caps: parsed.flatMap(({ modifiers, key }) => [...modifiers, key.length === 1 ? key.toUpperCase() : key]),
  };
}

export function createShortcutRegistry(): ShortcutRegistry {
  let entries: Entry[] = [];
  let activeScopes = new Set<string>();
  let listed: readonly ListedShortcut[] | null = null;
  let pending: { chord: string; timer: ReturnType<typeof setTimeout> } | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };
  const changed = () => {
    listed = null;
    notify();
  };
  const isActive = (entry: Entry) => entry.scope === undefined || activeScopes.has(entry.scope);

  const setPending = (next: string | null) => {
    if (pending) clearTimeout(pending.timer);
    pending = next ? { chord: next, timer: setTimeout(() => setPending(null), SEQUENCE_TIMEOUT_MS) } : null;
    notify();
  };

  // Whether an entry may run for this key press, leaving aside which key it is.
  const canRun = (e: Entry, typing: boolean, dialog: boolean) =>
    isActive(e) && (!typing || e.inFields) && (!dialog || e.inDialogs) && (e.when?.() ?? true);

  const run = (match: Entry, event: KeyboardEvent) => {
    event.preventDefault();
    match.run(event);
    return true;
  };

  // Two entries in the same scope clash when one's keys equal, or start, the other's.
  const clashes = (a: Entry, b: Entry) => {
    const n = Math.min(a.chords.length, b.chords.length);
    return a.scope === b.scope && a.chords.slice(0, n).join(' ') === b.chords.slice(0, n).join(' ');
  };

  return {
    register(shortcut) {
      const entry: Entry = { ...shortcut, ...parseKeys(shortcut.keys) };
      if (entry.inFields && entry.chords.some(isTypedKey))
        throw new Error(
          `"${shortcut.keys}" (${shortcut.label}) can't run in fields: it would swallow typing`,
        );
      const taken = entries.find((e) => clashes(e, entry));
      if (taken && taken.chords.length > entry.chords.length)
        throw new Error(`"${shortcut.keys}" starts "${taken.keys}" (${taken.label}, ${taken.group})`);
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
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return false;
      const typing = isTypingTarget(event.target);
      const dialog = inDialog(event.target);
      const eligible = entries.filter((e) => canRun(e, typing, dialog));
      const scopedFirst = (candidates: Entry[]) =>
        candidates.find((e) => e.scope !== undefined) ?? candidates[0];

      // The second key of a sequence: it finishes one, or cancels and does nothing else.
      if (pending) {
        const first = pending.chord;
        setPending(null);
        const match = scopedFirst(
          eligible.filter((e) => e.chords.length === 2 && e.chords[0] === first && e.chords[1] === pressed),
        );
        if (match) return run(match, event);
        event.preventDefault();
        return true;
      }

      const singles = eligible.filter((e) => e.chords.length === 1 && e.chords[0] === pressed);
      const single = scopedFirst(singles);
      const starts = eligible.some((e) => e.chords.length > 1 && e.chords[0] === pressed);
      if (starts && single?.scope === undefined) {
        setPending(pressed);
        event.preventDefault();
        return true;
      }
      return single ? run(single, event) : false;
    },

    list() {
      listed ??= entries.map((e) => ({
        keys: e.caps,
        sequence: e.chords.length > 1,
        label: e.label,
        group: e.group,
        scope: e.scope,
        active: isActive(e),
      }));
      return listed;
    },

    pending() {
      return pending?.chord ?? null;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
