// Settings → Data → Markdown copy folder, in the main process. The window asks for the system folder
// picker (or to turn the copy off); the folder chosen there is checked here and handed to the Core,
// which writes the copy. The window never names a folder, so it can't make Commander write anywhere.
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, parse, relative } from 'node:path';
import {
  type CoreMarkdownCopyReply,
  type CoreMarkdownCopyRequest,
  coreMarkdownCopyReply,
  type MarkdownCopyResponse,
  markdownCopyRequest,
} from '@commander/domain';

export type FolderCheck = { ok: true; folder: string } | { ok: false; error: string };

const realPath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

// Why the data folder itself can't be chosen, for the Markdown copy (and, by default, anything else).
const OWN_FOLDER =
  'That is Commander’s own data folder. Choose a folder outside it, such as one in Documents or an Obsidian vault.';

/**
 * Whether the copy may go in this folder: an existing one, not the whole disk, not Commander's own.
 * Export everything (#202) checks its folder the same way, with its own word for the data folder.
 */
export function checkCopyFolder(path: string, userData: string, ownFolder = OWN_FOLDER): FolderCheck {
  if (!isAbsolute(path)) return { ok: false, error: 'Choose a folder by its full path.' };
  const folder = realPath(path);
  if (!folder) return { ok: false, error: 'That folder can’t be found.' };
  if (!statSync(folder).isDirectory()) return { ok: false, error: 'That isn’t a folder.' };
  if (folder === parse(folder).root) return { ok: false, error: 'Choose a folder, not the whole disk.' };
  const data = realPath(userData) ?? userData;
  const inData = relative(data, folder);
  if (inData === '' || (!inData.startsWith('..') && !isAbsolute(inData))) {
    return { ok: false, error: ownFolder };
  }
  return { ok: true, folder };
}

type CoreRequest = CoreMarkdownCopyRequest['request'];
type CoreResponse = CoreMarkdownCopyReply['response'];

const TIMEOUT_MS = 10_000;

export function createMarkdownCopyChannel(options: {
  userData: string;
  send(message: CoreMarkdownCopyRequest): void;
  // Shows the system folder picker; null when cancelled.
  chooseFolder(): Promise<string | null>;
}) {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (response: CoreResponse | null) => void; timer: NodeJS.Timeout }
  >();

  // Asks the Core; null when it didn't answer in time.
  function ask(request: CoreRequest): Promise<CoreResponse | null> {
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      options.send({ type: 'markdown-copy-request', id, request });
    });
  }

  const relay = async (request: CoreRequest): Promise<MarkdownCopyResponse> =>
    (await ask(request)) ?? { ok: false, error: 'The Core did not answer in time', status: null };

  return {
    // A request from the window.
    async request(raw: unknown): Promise<MarkdownCopyResponse> {
      const parsed = markdownCopyRequest.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: `Rejected Markdown copy request: ${parsed.error.message}`, status: null };
      }
      switch (parsed.data.op) {
        case 'status':
          return relay({ op: 'status' });
        case 'turn-off':
          return relay({ op: 'set-folder', folder: null });
        case 'choose-folder': {
          const chosen = await options.chooseFolder();
          if (!chosen) return relay({ op: 'status' });
          const checked = checkCopyFolder(chosen, options.userData);
          if (!checked.ok) {
            const current = await ask({ op: 'status' });
            return { ok: false, error: checked.error, status: current?.status ?? null };
          }
          return relay({ op: 'set-folder', folder: checked.folder });
        }
      }
    },

    // Where the copy is written, as the Core keeps it (for Wipe all Commander data, #204); null when
    // the copy is off or the Core didn't answer.
    async folder(): Promise<string | null> {
      return (await ask({ op: 'status' }))?.status.folder ?? null;
    },

    // A message from the Core. Returns true when it was a Markdown copy reply, handled here.
    settle(raw: unknown): boolean {
      const parsed = coreMarkdownCopyReply.safeParse(raw);
      if (!parsed.success) return false;
      const waiting = pending.get(parsed.data.id);
      if (waiting) {
        pending.delete(parsed.data.id);
        clearTimeout(waiting.timer);
        waiting.resolve(parsed.data.response);
      }
      return true;
    },
  };
}
