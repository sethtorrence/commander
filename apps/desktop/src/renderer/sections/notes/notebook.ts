import { attachmentMarkdown } from '@commander/domain';
import { enterTodo, makeTodo, removeTodo, tickTodo, typeTodoMark } from './block-todos';
import type { DailyNotes } from './daily-notes';
import {
  type BlockChange,
  type Caret,
  type Edit,
  enter,
  indent,
  insertBelow,
  joinNext,
  move,
  type Outline,
  outdent,
  outlineOf,
  removeBackward,
  removeBlock,
  setText,
  startOutline,
  toggleFold,
  visibleBlocks,
} from './outline';

/*
  The Notes Section's working state: the stream of Daily Notes on screen, each with its outline, kept
  in step with the Item store.

  - Edits apply here at once and are saved in the background, one at a time and in order, so the
    window never waits on the Core. New Blocks get their ids here, so they keep them for good.
  - Typing is held back until the User pauses (typingPauseMs), then saved as one change, so the
    activity log gets one entry per pause rather than per keystroke. Every other edit flushes it
    first, and `flush()` saves whatever is held (Commander calls it before quitting).
  - Each edit, and each pause in typing, is one step to undo. Undo puts the outline back here and
    asks the Item store to undo that step's activity entries; redo undoes those undos.
  - A Block can be a Todo (block-todos.ts): `[] ` typed at its start, or Ctrl+Enter, makes one;
    its checkbox ticks it; deleting the checkbox or the Block deletes the Todo. Each is one step to
    undo, saved together with the Block. Changes made in the Todos Section show after `refresh()`.
  - A day that has no Daily Note yet (an empty past day opened from the week strip) shows blank, and
    its Daily Note is made only when the User writes in it.
  - Today's Daily Note, made when Notes first opens or when the date moves on while it is open, starts
    with a copy of the daily template (made by the Item store, with fresh ids). A blank past day
    never does.
*/

export interface DayState {
  /** The local date, YYYY-MM-DD. */
  day: string;
  /** Its Daily Note Item, or null while it has none (a blank day not written in yet). */
  noteId: string | null;
  outline: Outline;
}

export interface NotebookSnapshot {
  today: string;
  /** The days on screen, newest first: today, then earlier days. */
  days: readonly DayState[];
  /** Whether earlier days with something written are still to load. */
  hasMore: boolean;
  /** How many days before today have something written (for "Sheet 02 / 14"). */
  olderTotal: number;
  started: boolean;
}

export interface NotebookOptions {
  today: string;
  /** Makes the id for a new Block (a UUID). */
  newId?: () => string;
  /** How many earlier days to load at a time. */
  pageSize?: number;
  /** How long typing must pause before it is saved. */
  typingPauseMs?: number;
  /** Told when something couldn't be saved or loaded. */
  onError?: (message: string) => void;
}

export interface Notebook {
  snapshot(): NotebookSnapshot;
  subscribe(listener: () => void): () => void;
  /** Makes today's Daily Note if needed and loads the first days. */
  start(): Promise<void>;
  /** Loads the next page of earlier days. */
  loadMore(): Promise<void>;
  /** Makes sure a day is on screen: loads down to it, or opens it blank if it has no Daily Note. */
  showDay(day: string): Promise<void>;
  /** Moves today on (past local midnight): the new day goes on top. */
  setToday(day: string): Promise<void>;
  /** Which days from `from` to `to` (inclusive) have something written. */
  daysWithContent(from: string, to: string): Promise<Set<string>>;

  /**
   * The User's text for a Block, as typed, with the caret at `caret`. Saved after a pause. `[] ` typed
   * at the start of a plain Block makes it a Todo at once: the mark goes, and the caret to put back
   * in the Block is returned (null otherwise).
   */
  type(day: string, id: string, text: string, caret?: number): Caret | null;
  /** Writing in an empty day: makes its first Block, holding `text`. */
  begin(day: string, text: string): Caret;
  enter(day: string, id: string, start: number, end: number): Caret | null;
  indent(day: string, id: string, offset: number): Caret | null;
  outdent(day: string, id: string, offset: number): Caret | null;
  move(day: string, id: string, direction: 'up' | 'down', offset: number): Caret | null;
  removeBackward(day: string, id: string): Caret | null;
  joinNext(day: string, id: string): Caret | null;
  toggleFold(day: string, id: string): boolean;
  /** Ctrl+Enter on a plain Block: makes it a Todo. Null if it is one already. */
  makeTodo(day: string, id: string, offset?: number): Caret | null;
  /** Ticks a Todo Block's Todo, or unticks it. Returns false if the Block isn't a Todo. */
  tick(day: string, id: string): boolean;
  /** Deletes a Block's checkbox: it becomes a plain Block, and its Todo is deleted. */
  removeTodo(day: string, id: string): Caret | null;
  /** Reads the days on screen again, for changes made elsewhere (the Todos Section). */
  refresh(): Promise<void>;
  /** Makes sure the day holding a Block is on screen, and returns that day (null if it isn't found). */
  reveal(blockId: string): Promise<string | null>;
  /** Removes a Block whatever its text (an image Block). */
  remove(day: string, id: string): Caret | null;
  /**
   * Pasted or dropped images: each is saved by the Core, then put in its own Block below `id` (or
   * starts the empty day when `id` is null). Returns the caret on the last one, or null if none was saved.
   */
  attach(day: string, id: string | null, images: Uint8Array[]): Promise<Caret | null>;
  /** Undoes the last step; returns where the caret was before it. */
  undo(): Caret | null;
  /** Redoes the last undone step; returns where the caret was after it. */
  redo(): Caret | null;
  /** Saves any held-back typing and waits until every change so far is saved. */
  flush(): Promise<void>;
}

interface Step {
  day: string;
  before: Outline;
  after: Outline;
  focusBefore: Caret;
  focusAfter: Caret;
  /** The activity entries that made this step, in order (filled in once saved). */
  entries: number[];
}

const EMPTY: Outline = new Map();
const lastShown = (outline: Outline) => visibleBlocks(outline).at(-1)?.block.id ?? null;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createNotebook(api: DailyNotes, options: NotebookOptions): Notebook {
  const {
    newId = () => crypto.randomUUID(),
    pageSize = 7,
    typingPauseMs = 800,
    onError = () => {},
  } = options;
  let state: NotebookSnapshot = {
    today: options.today,
    days: [],
    hasMore: false,
    olderTotal: 0,
    started: false,
  };
  const listeners = new Set<() => void>();
  let undoStack: Step[] = [];
  let redoStack: Step[] = [];
  let typing: { day: string; id: string; step: Step; timer: ReturnType<typeof setTimeout> } | null = null;
  let queue: Promise<void> = Promise.resolve();
  let starting: Promise<void> | null = null;

  const set = (next: Partial<NotebookSnapshot>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const sortDays = (days: DayState[]) =>
    [...days].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  const findDay = (day: string) => state.days.find((d) => d.day === day);
  const outlineOfDay = (day: string) => findDay(day)?.outline ?? EMPTY;
  const setDay = (day: string, change: Partial<DayState>) =>
    set({ days: state.days.map((d) => (d.day === day ? { ...d, ...change } : d)) });

  // Runs tasks against the Item store one at a time, in order. A failure is reported, and the days on
  // screen are reloaded so they match what was saved.
  function enqueue(task: () => Promise<void>): Promise<void> {
    queue = queue.then(task).catch(async (error) => {
      onError(`Couldn’t save the Daily Note: ${message(error)}`);
      undoStack = [];
      redoStack = [];
      await reload().catch((again) => onError(message(again)));
    });
    return queue;
  }

  async function noteIdFor(day: string): Promise<string> {
    const existing = findDay(day)?.noteId;
    if (existing) return existing;
    const noteId = await api.ensure(day);
    setDay(day, { noteId });
    return noteId;
  }

  // `before` is the day's outline as saved before these changes, so their Todos change with them.
  function save(day: string, changes: BlockChange[], why: string, before: Outline, step?: Step) {
    if (!changes.length) return;
    enqueue(async () => {
      const entries = await api.save(await noteIdFor(day), changes, why, before);
      if (step) step.entries = entries;
    });
  }

  async function load(notes: { day: string; noteId: string }[]): Promise<DayState[]> {
    const blocks = await api.blocks(notes.map((note) => note.noteId));
    return notes.map(({ day, noteId }) => ({ day, noteId, outline: outlineOf(blocks.get(noteId) ?? []) }));
  }

  async function reload() {
    const saved = state.days.filter((d): d is DayState & { noteId: string } => d.noteId !== null);
    const fresh = new Map((await load(saved)).map((d) => [d.day, d]));
    set({ days: state.days.map((d) => fresh.get(d.day) ?? d) });
  }

  function addDays(days: DayState[]) {
    const known = new Set(state.days.map((d) => d.day));
    set({ days: sortDays([...state.days, ...days.filter((d) => !known.has(d.day))]) });
  }

  const olderSaved = () => state.days.filter((d) => d.day < state.today && d.noteId);
  const oldestLoaded = () => olderSaved().at(-1)?.day;

  // Loads the next page of earlier days with something written, or (with `from`) every one down to that day.
  async function loadOlder(from?: string) {
    const shown = olderSaved().length;
    const before = oldestLoaded() ?? state.today;
    const page = await api.list({ withContent: true, before, from, limit: from ? 1000 : pageSize });
    addDays(await load(page.notes.map((note) => ({ day: note.day, noteId: note.item.id }))));
    // Loading down to a day says nothing about the days before it: the next page will tell.
    if (!from) set({ olderTotal: shown + page.total, hasMore: page.total > page.notes.length });
  }

  // ---- held-back typing ----

  function flushTyping() {
    if (!typing) return;
    const { day, id, step, timer } = typing;
    typing = null;
    clearTimeout(timer);
    const block = outlineOfDay(day).get(id);
    if (!block || step.before.get(id)?.text === block.text) {
      undoStack = undoStack.filter((s) => s !== step);
      return;
    }
    step.after = outlineOfDay(day);
    step.focusAfter = { id, offset: block.text.length };
    save(day, [{ type: 'update', block }], 'Typing', step.before, step);
  }

  // ---- edits ----

  // `before` is the outline as saved, which the step goes back to: the day's outline unless typing
  // held back is being folded into this step.
  function commit(
    day: string,
    edit: Edit | null,
    why: string,
    focusBefore: Caret,
    before = outlineOfDay(day),
  ): Caret | null {
    if (!edit) return null;
    setDay(day, { outline: edit.outline });
    const focusAfter = edit.focus ?? focusBefore;
    if (edit.changes.length) {
      const step: Step = { day, before, after: edit.outline, focusBefore, focusAfter, entries: [] };
      undoStack.push(step);
      redoStack = [];
      save(day, edit.changes, why, before, step);
    }
    return focusAfter;
  }

  // Flushes held typing, then makes an edit to a day's outline.
  function edit(day: string, why: string, focusBefore: Caret, make: (outline: Outline) => Edit | null) {
    flushTyping();
    return commit(day, make(outlineOfDay(day)), why, focusBefore);
  }

  const removeCheckbox = (day: string, id: string) =>
    edit(day, 'Remove the Todo', { id, offset: 0 }, (outline) => removeTodo(outline, id));

  function undoRedo(from: Step[], to: Step[], direction: 'undo' | 'redo'): Caret | null {
    flushTyping();
    const step = from.pop();
    if (!step) return null;
    to.push(step);
    setDay(step.day, { outline: direction === 'undo' ? step.before : step.after });
    enqueue(async () => {
      step.entries = await api.undo(step.entries);
    });
    return direction === 'undo' ? step.focusBefore : step.focusAfter;
  }

  const notebook: Notebook = {
    snapshot: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start() {
      starting ??= (async () => {
        try {
          const noteId = await api.ensure(state.today, { fromTemplate: true });
          addDays(await load([{ day: state.today, noteId }]));
          await loadOlder();
        } catch (error) {
          onError(`Couldn’t open the Daily Notes: ${message(error)}`);
        }
        set({ started: true });
      })();
      return starting;
    },

    async loadMore() {
      if (!state.hasMore) return;
      await loadOlder().catch((error) => onError(message(error)));
    },

    async showDay(day) {
      if (findDay(day) || day > state.today) return;
      try {
        const oldest = oldestLoaded();
        if (state.hasMore && (!oldest || day < oldest)) await loadOlder(day);
        if (!findDay(day)) addDays([{ day, noteId: null, outline: EMPTY }]);
      } catch (error) {
        onError(message(error));
      }
    },

    async setToday(day) {
      if (day === state.today) return;
      // Yesterday's note joins the earlier days if it has something written.
      const written = [...outlineOfDay(state.today).values()].some((block) => block.text !== '');
      set({ today: day, olderTotal: state.olderTotal + (written ? 1 : 0) });
      try {
        const noteId = await api.ensure(day, { fromTemplate: true });
        const existing = findDay(day);
        if (existing) setDay(day, { noteId });
        else addDays(await load([{ day, noteId }]));
      } catch (error) {
        onError(message(error));
      }
    },

    async daysWithContent(from, to) {
      const page = await api.list({ withContent: true, from, to, limit: 1000 });
      const days = new Set(page.notes.map((note) => note.day));
      // Writing not saved yet counts too.
      for (const d of state.days) {
        if (d.day >= from && d.day <= to && [...d.outline.values()].some((b) => b.text !== ''))
          days.add(d.day);
      }
      return days;
    },

    type(day, id, text, caret) {
      const before = outlineOfDay(day);
      const todo = api.todos !== false ? typeTodoMark(before, id, text, caret, newId()) : null;
      if (todo?.focus) {
        // The typing that led up to the mark is folded into this one step.
        const held = typing?.day === day && typing.id === id ? typing : null;
        if (held) {
          clearTimeout(held.timer);
          typing = null;
          undoStack = undoStack.filter((s) => s !== held.step);
        } else flushTyping();
        const saved = held?.step.before ?? before;
        return commit(day, todo, 'Make a Todo', held?.step.focusBefore ?? todo.focus, saved);
      }
      const changed = setText(before, id, text);
      if (!changed) return null;
      if (typing && (typing.day !== day || typing.id !== id)) flushTyping();
      let step = typing?.step;
      if (!step) {
        // The first keystroke after a pause starts a step, so undo takes typing back a pause at a time.
        const caret = { id, offset: before.get(id)?.text.length ?? 0 };
        step = { day, before, after: changed.outline, focusBefore: caret, focusAfter: caret, entries: [] };
        undoStack.push(step);
        redoStack = [];
      }
      if (typing) clearTimeout(typing.timer);
      typing = { day, id, step, timer: setTimeout(flushTyping, typingPauseMs) };
      setDay(day, { outline: changed.outline });
      return null;
    },

    begin(day, text) {
      flushTyping();
      const id = newId();
      const started = startOutline(id, outlineOfDay(day));
      const withText = text
        ? (setText(started.outline, id, text)?.outline ?? started.outline)
        : started.outline;
      const block = withText.get(id);
      const edit: Edit = {
        outline: withText,
        changes: block ? [{ type: 'create', block }] : [],
        focus: { id, offset: text.length },
      };
      return commit(day, edit, 'New Block', { id, offset: 0 }) ?? { id, offset: text.length };
    },

    enter(day, id, start, end) {
      return edit(day, 'New Block', { id, offset: start }, (outline) =>
        outline.get(id)?.todo
          ? enterTodo(outline, id, start, end, newId)
          : enter(outline, id, start, end, newId()),
      );
    },

    indent(day, id, offset) {
      const caret = { id, offset };
      return edit(day, 'Indent', caret, (outline) => indent(outline, id)) && caret;
    },

    outdent(day, id, offset) {
      const caret = { id, offset };
      return edit(day, 'Outdent', caret, (outline) => outdent(outline, id)) && caret;
    },

    move(day, id, direction, offset) {
      const caret = { id, offset };
      return edit(day, 'Move', caret, (outline) => move(outline, id, direction)) && caret;
    },

    removeBackward(day, id) {
      // Backspace at the start of a Todo deletes its checkbox first.
      if (outlineOfDay(day).get(id)?.todo) return removeCheckbox(day, id);
      return edit(day, 'Remove Block', { id, offset: 0 }, (outline) => removeBackward(outline, id));
    },

    joinNext(day, id) {
      const offset = outlineOfDay(day).get(id)?.text.length ?? 0;
      return edit(day, 'Join Blocks', { id, offset }, (outline) => joinNext(outline, id));
    },

    toggleFold(day, id) {
      const folded = outlineOfDay(day).get(id)?.folded;
      const offset = outlineOfDay(day).get(id)?.text.length ?? 0;
      return !!edit(day, folded ? 'Unfold' : 'Fold', { id, offset }, (outline) => toggleFold(outline, id));
    },

    makeTodo(day, id, offset) {
      const caret = { id, offset: offset ?? outlineOfDay(day).get(id)?.text.length ?? 0 };
      if (api.todos === false) return null;
      return edit(day, 'Make a Todo', caret, (outline) => makeTodo(outline, id, newId()));
    },

    tick(day, id) {
      const block = outlineOfDay(day).get(id);
      const caret = { id, offset: block?.text.length ?? 0 };
      return !!edit(day, block?.todo?.done ? 'Untick' : 'Tick', caret, (outline) => tickTodo(outline, id));
    },

    removeTodo: removeCheckbox,

    refresh() {
      flushTyping();
      return enqueue(reload);
    },

    async reveal(blockId) {
      const day = await api.dayOfBlock(blockId).catch((error) => {
        onError(message(error));
        return null;
      });
      if (day) await notebook.showDay(day);
      return day;
    },

    remove(day, id) {
      return edit(day, 'Remove Block', { id, offset: 0 }, (outline) => removeBlock(outline, id));
    },

    async attach(day, id, images) {
      let caret: Caret | null = null;
      let below = id;
      for (const bytes of images) {
        let name: string;
        try {
          name = await api.saveImage(bytes);
        } catch (error) {
          onError(`Couldn’t paste the image: ${message(error)}`);
          continue;
        }
        const text = attachmentMarkdown(name);
        // The Block may have gone while the image was saving: then it goes at the end of the day.
        const target = below && outlineOfDay(day).has(below) ? below : lastShown(outlineOfDay(day));
        caret = target
          ? edit(day, 'Paste image', { id: target, offset: 0 }, (outline) =>
              insertBelow(outline, target, text, newId()),
            )
          : notebook.begin(day, text);
        below = caret?.id ?? below;
      }
      return caret;
    },

    undo: () => undoRedo(undoStack, redoStack, 'undo'),
    redo: () => undoRedo(redoStack, undoStack, 'redo'),

    async flush() {
      flushTyping();
      await queue;
    },
  };
  return notebook;
}
