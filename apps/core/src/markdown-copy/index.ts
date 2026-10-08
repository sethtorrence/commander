/*
  The read-only Markdown copy of the Daily Notes (#53): one `YYYY-MM-DD.md` per day, in a folder the
  User chose in Settings → Data, for Obsidian, grep and backups. The database stays the source of
  truth: nothing in the folder is ever read back.

  - Off until a folder is chosen. Choosing or changing it writes every day with something written in
    it; a day's file is rewritten about two seconds after its Blocks (or Todos) last changed.
  - Each file is written beside its real name and renamed into place, so it is never half-written,
    and only when its text changed. The images a day shows are copied into `attachments/` there.
  - Only `YYYY-MM-DD.md` and `attachments/<sha256>.<ext>` are written; nothing else in the folder is
    read, changed or deleted, so it can sit inside an Obsidian vault. A day's file is never deleted
    either: a day emptied of Blocks is rewritten with nothing under the notice.
  - When writing fails (the folder gone, no permission), the status says why, for Settings, and
    Commander tries again every so often; editing never waits on any of it.
*/
import { randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  addressName,
  attachmentsIn,
  type CoreMarkdownCopyReply,
  type CoreMessage,
  coreMarkdownCopyRequest,
  type Item,
  isOwnFiling,
  type MarkdownCopyStatus,
  meetingLine,
} from '@commander/domain';
import type { ItemStore } from '../item-store';
import { type CopyBlock, type CopyProjects, dailyNoteMarkdown } from './serialize';

export { dailyNoteMarkdown, READ_ONLY_NOTICE } from './serialize';

// An email link as one line: "Email from Dana Whitfield: Q4 budget" (undefined for one Commander lacks).
function emailLine(item: Item | undefined): string | undefined {
  if (item?.detail?.kind !== 'email') return undefined;
  const from = addressName(item.detail.from);
  const subject = item.detail.subject.trim() || '(no subject)';
  return from ? `Email from ${from}: ${subject}` : `Email: ${subject}`;
}

export type MarkdownCopyOptions = {
  store: ItemStore;
  // The app's data folder: the copy may not go in it (or be it).
  dataDir: string;
  // Where the pasted images are, to copy from.
  attachmentsDir: string;
  send(message: CoreMessage | CoreMarkdownCopyReply): void;
  // How long after the last change a day is written.
  debounceMs?: number;
  // How long after a failed write it is tried again.
  retryMs?: number;
  now?: () => number;
};

// Item store requests that can change many days' files at once: a Project renamed, recoded or merged
// changes its `[[name]]` and `#CODE`, and re-filing by Rules changes Blocks' own Projects.
const CHANGES_ALL = new Set(['change-project', 'refile', 'undo-refile']);

// Files no bigger than this are compared before rewriting; anything bigger is just rewritten.
const COMPARE_UP_TO = 8 * 1024 * 1024;

/** Why a folder can't take the copy, or null when it can. */
export function refusedFolder(folder: string, dataDir: string): string | null {
  if (!isAbsolute(folder)) return 'Choose a folder by its full path.';
  const path = resolve(folder);
  if (path === parse(path).root) return 'Choose a folder, not the whole disk.';
  const inData = relative(resolve(dataDir), path);
  if (inData === '' || (!inData.startsWith('..') && !isAbsolute(inData)))
    return 'That is Commander’s own data folder. Choose a folder outside it, such as one in Documents or an Obsidian vault.';
  return null;
}

// A sentence for Settings about a failed write.
function problemOf(error: unknown, folder: string): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case 'ENOENT':
      return `The folder ${folder} can’t be found. Reconnect the disk, or choose another folder.`;
    case 'EACCES':
    case 'EPERM':
      return `Commander isn’t allowed to write in ${folder}.`;
    case 'EROFS':
      return `${folder} is on a read-only disk.`;
    case 'ENOSPC':
      return `The disk holding ${folder} is full.`;
    case 'ENOTDIR':
      return `${folder} isn’t a folder.`;
    default:
      return `Couldn’t write to ${folder}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const tempName = (name: string) => `.${name}.${randomBytes(6).toString('hex')}.tmp`;

// Writes beside the real name, then renames into place: never half a file under the real name.
async function writeAtomically(dir: string, name: string, write: (temp: string) => Promise<void>) {
  const temp = join(dir, tempName(name));
  try {
    await write(temp);
    await rename(temp, join(dir, name));
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Writes Daily Notes as Markdown files (the copy's format), each with the images it shows in
 * `attachments/` beside it. The Markdown copy keeps a folder up to date with it; Export everything
 * (#202) writes every day once.
 */
export function dailyNoteFiles(store: ItemStore, attachmentsDir: string) {
  function projectsLookup(): CopyProjects {
    const refs = new Map<string, ReturnType<ItemStore['projectRef']>>();
    const ref = (id: string) => {
      if (!refs.has(id)) refs.set(id, store.projectRef(id));
      return refs.get(id) ?? null;
    };
    return { code: (id) => ref(id)?.code, name: (id) => ref(id)?.title };
  }

  function copyBlocksOf(dailyNoteId: string): CopyBlock[] {
    // Should a Block have more than one live Todo, the latest made wins (as in Notes).
    const todos = new Map(
      store.blockTodos({ dailyNoteIds: [dailyNoteId] }).map(({ todo, block }) => [block.id, todo]),
    );
    return store.blocks([dailyNoteId]).flatMap((item) => {
      if (item.detail?.kind !== 'block') return [];
      const { parentId, position, text, style = 'plain' } = item.detail;
      const todo = todos.get(item.id);
      return [
        {
          id: item.id,
          parentId,
          position,
          text,
          style,
          ownProjectId: item.filing && isOwnFiling(item.filing) ? item.filing.projectId : null,
          todo: todo ? (todo.status === 'done' ? 'done' : 'open') : null,
        },
      ];
    });
  }

  async function writeImages(into: string, blocks: CopyBlock[]) {
    const names = new Set(blocks.flatMap((block) => attachmentsIn(block.text)));
    if (!names.size) return;
    const dir = join(into, 'attachments');
    await mkdir(dir, { recursive: true });
    for (const name of names) {
      // Named by their content, so one already there is this image.
      if (await exists(join(dir, name))) continue;
      const from = join(attachmentsDir, name);
      try {
        await writeAtomically(dir, name, (temp) => copyFile(from, temp));
      } catch (error) {
        // An image Commander no longer has is left out; the embed stays in the text.
        if (missing(error) && !(await exists(from))) continue;
        throw error;
      }
    }
  }

  // Writes a day's file if its text changed. Whether it wrote anything.
  async function writeDay(
    into: string,
    day: string,
    dailyNoteId: string,
    projects: CopyProjects,
  ): Promise<boolean> {
    const blocks = copyBlocksOf(dailyNoteId);
    const name = `${day}.md`;
    const path = join(into, name);
    const existing = await lstat(path).catch((error) => {
      if (missing(error)) return null;
      throw error;
    });
    // A day gets a file once something is written in it; one with a file keeps it up to date.
    if (!existing && !blocks.some((block) => block.text.trim() !== '')) return false;
    // A meeting chip reads as its meeting, as it stands for this day (cancelled, moved).
    const meeting = (eventId: string) => meetingLine(store.get(eventId)?.item, day);
    const email = (emailId: string) => emailLine(store.get(emailId)?.item);
    const text = dailyNoteMarkdown(blocks, { ...projects, meeting, email });
    await writeImages(into, blocks);
    if (existing?.isFile() && existing.size <= COMPARE_UP_TO) {
      if ((await readFile(path, 'utf8')) === text) return false;
    }
    await writeAtomically(into, name, (temp) => writeFile(temp, text, 'utf8'));
    return true;
  }

  // Every Daily Note, newest first, as day and id.
  function allDays(): { day: string; id: string }[] {
    const found: { day: string; id: string }[] = [];
    let before: string | undefined;
    for (;;) {
      const page = store.dailyNotes({ limit: 1000, ...(before && { before }) });
      for (const note of page.notes) found.push({ day: note.day, id: note.item.id });
      if (page.notes.length < 1000) return found;
      before = page.notes.at(-1)?.day;
    }
  }

  return { projectsLookup, writeDay, allDays };
}

export function setUpMarkdownCopy(options: MarkdownCopyOptions) {
  const { store, send } = options;
  const debounceMs = options.debounceMs ?? 2000;
  const retryMs = options.retryMs ?? 15_000;
  const now = options.now ?? Date.now;

  let folder = store.markdownCopyFolder.read();
  let status: MarkdownCopyStatus = folder
    ? { folder, state: 'writing', problem: null, lastWrittenAt: null }
    : { folder: null, state: 'off', problem: null, lastWrittenAt: null };

  // What is waiting to be written.
  const pendingDays = new Set<string>();
  // Items changed, whose days are worked out when writing (a sync can change thousands of Items).
  const pendingItems = new Set<string>();
  let pendingAll = !!folder;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  function setStatus(next: MarkdownCopyStatus) {
    if (isDeepStrictEqual(next, status)) return;
    status = next;
    send({ type: 'markdown-copy-status', status });
  }

  function schedule(delay: number) {
    if (!folder || stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delay);
  }

  const files = dailyNoteFiles(store, options.attachmentsDir);

  // The day an Item's change shows on: a Daily Note's own, a Block's note's, a Todo's Block's.
  function dayOf(itemId: string, depth = 0): string | null {
    const view = store.get(itemId);
    const detail = view?.item.detail;
    if (!view || !detail || depth > 2) return null;
    if (detail.kind === 'daily-note') return detail.day;
    if (detail.kind === 'block') return dayOf(detail.dailyNoteId, depth + 1);
    if (view.item.kind === 'todo') {
      const made = view.links.find((link) => link.type === 'made-from' && link.to.kind === 'block');
      return made ? dayOf(made.to.id, depth + 1) : null;
    }
    return null;
  }

  // The days whose meeting chips (or other `[[` links) show an event that changed.
  function meetingDaysOf(itemId: string): string[] {
    const item = store.get(itemId)?.item;
    if (item?.kind !== 'event') return [];
    return store.mentions({ targets: [{ targetType: 'item', id: itemId }] }).map((found) => found.day);
  }

  async function writePending() {
    const into = folder;
    if (!into) return;
    const all = pendingAll;
    for (const id of all ? [] : pendingItems) {
      const day = dayOf(id);
      if (day) pendingDays.add(day);
      for (const mentioned of meetingDaysOf(id)) pendingDays.add(mentioned);
    }
    const days = [...pendingDays];
    pendingAll = false;
    pendingDays.clear();
    pendingItems.clear();
    try {
      const info = await stat(into);
      if (!info.isDirectory()) throw Object.assign(new Error('Not a folder'), { code: 'ENOTDIR' });
      const projects = files.projectsLookup();
      let wrote = false;
      const targets = all
        ? files.allDays()
        : days.flatMap((day) => {
            const note = store.dailyNotes({ from: day, to: day, limit: 1 }).notes[0];
            return note ? [{ day, id: note.item.id }] : [];
          });
      for (const { day, id } of targets) {
        // The folder changed (or the copy was turned off) meanwhile: that change writes everything.
        if (folder !== into || stopped) return;
        if (await files.writeDay(into, day, id, projects)) wrote = true;
      }
      if (folder !== into) return;
      const lastWrittenAt = wrote ? now() : status.lastWrittenAt;
      setStatus({ folder: into, state: 'ok', problem: null, lastWrittenAt });
    } catch (error) {
      if (folder !== into) return;
      // Whatever didn't get written waits for the next try.
      pendingAll ||= all;
      for (const day of days) pendingDays.add(day);
      setStatus({ ...status, folder: into, state: 'failed', problem: problemOf(error, into) });
      schedule(retryMs);
    }
  }

  // One write at a time; changes arriving meanwhile go in the next.
  async function run(): Promise<void> {
    if (running) {
      await running;
      return run();
    }
    if (!pendingAll && !pendingDays.size && !pendingItems.size) return;
    running = writePending().finally(() => {
      running = null;
    });
    await running;
  }

  function setFolder(next: string | null) {
    store.markdownCopyFolder.save(next);
    folder = next;
    pendingDays.clear();
    pendingItems.clear();
    if (timer) clearTimeout(timer);
    timer = null;
    pendingAll = !!next;
    setStatus(
      next
        ? { folder: next, state: 'writing', problem: null, lastWrittenAt: null }
        : { folder: null, state: 'off', problem: null, lastWrittenAt: null },
    );
    schedule(0);
  }

  return {
    /** Catches up at start-up: the folder may have been fixed, or changes missed, since. */
    start() {
      if (folder) schedule(debounceMs);
    },

    /** Answers the main process's requests. False for any other message. */
    handle(raw: unknown): boolean {
      const parsed = coreMarkdownCopyRequest.safeParse(raw);
      if (!parsed.success) return false;
      const { id, request } = parsed.data;
      const reply = (response: CoreMarkdownCopyReply['response']) =>
        send({ type: 'markdown-copy-reply', id, response });
      if (request.op === 'set-folder') {
        const refused = request.folder === null ? null : refusedFolder(request.folder, options.dataDir);
        if (refused) {
          reply({ ok: false, error: refused, status });
          return true;
        }
        setFolder(request.folder === null ? null : resolve(request.folder));
      }
      reply({ ok: true, status });
      return true;
    },

    /** Items changed (as the Core tells the window): their days are written after a pause. */
    itemsChanged(itemIds: readonly string[]) {
      if (!folder || !itemIds.length) return;
      for (const id of itemIds) pendingItems.add(id);
      schedule(debounceMs);
    },

    /** An Item store request was answered: some change days without saying which Items changed. */
    afterRequest(request: unknown) {
      if (!folder) return;
      const { op, day } = (request ?? {}) as { op?: unknown; day?: unknown };
      if (op === 'daily-note' && typeof day === 'string') pendingDays.add(day);
      else if (typeof op === 'string' && CHANGES_ALL.has(op)) pendingAll = true;
      else return;
      schedule(debounceMs);
    },

    status: () => status,

    /** Writes whatever is waiting now, and resolves when it's written (or has failed). */
    async flush() {
      if (timer) clearTimeout(timer);
      timer = null;
      await run();
    },

    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export type MarkdownCopy = ReturnType<typeof setUpMarkdownCopy>;
