// Settings → Data → Snapshots and Export (#202), in the main process. The window asks; the Core lists
// the snapshots, marks one to restore and writes exports. Two things only the main process does:
//
// - Restore: once the User has typed the confirmation (or, on the recovery screen, #203, chosen
//   Restore) and the Core has checked and marked the snapshot, Commander relaunches (a clean quit, so the window saves and held messages go first, and
//   the supervisor never mistakes the Core stopping for a crash); the new Core makes the restore
//   before it opens the database.
// - Export everything: the folder comes from the system folder picker, checked here (an existing
//   folder, not the whole disk, not Commander's own data folder) before the Core hears it. The window
//   never names a folder.
import {
  type BackupsResponse,
  backupsRequest,
  type CoreBackupsReply,
  type CoreBackupsRequest,
  confirmsRestore,
  coreBackupsReply,
  RESTORE_WORD,
} from '@commander/domain';
import { checkCopyFolder } from './markdown-copy-channel';

type CoreRequest = CoreBackupsRequest['request'];
type CoreResponse = CoreBackupsReply['response'];

const TIMEOUT_MS = 30_000;
// The pause between the window hearing a restore was accepted and Commander quitting to relaunch.
const RELAUNCH_AFTER_MS = 300;

const OWN_FOLDER =
  'That is Commander’s own data folder. Choose a folder outside it, such as one in Documents.';

export function createBackupsChannel(options: {
  userData: string;
  send(message: CoreBackupsRequest): void;
  // Shows the system folder picker; null when cancelled.
  chooseFolder(): Promise<string | null>;
  // Relaunches Commander (app.relaunch, then a clean quit).
  relaunch(): void;
  relaunchAfterMs?: number;
}) {
  let nextId = 1;
  let relaunching = false;
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
      options.send({ type: 'backups-request', id, request });
    });
  }

  const relay = async (request: CoreRequest): Promise<BackupsResponse> =>
    (await ask(request)) ?? { ok: false, error: 'The Core did not answer in time', status: null };

  // A restore the Core accepted: Commander relaunches to make it.
  function relaunchAfter(response: BackupsResponse): BackupsResponse {
    if (!response.ok) return response;
    relaunching = true;
    // After the reply, so the window can say Commander is relaunching.
    setTimeout(() => options.relaunch(), options.relaunchAfterMs ?? RELAUNCH_AFTER_MS);
    return { ...response, relaunching: true };
  }

  return {
    // A request from the window.
    async request(raw: unknown): Promise<BackupsResponse> {
      const parsed = backupsRequest.safeParse(raw);
      if (!parsed.success)
        return { ok: false, error: `Rejected backups request: ${parsed.error.message}`, status: null };
      const request = parsed.data;
      switch (request.op) {
        case 'status':
        case 'cancel-export':
          return relay(request);
        case 'restore': {
          if (!confirmsRestore(request.confirmation)) {
            const current = await ask({ op: 'status' });
            return {
              ok: false,
              error: `Type “${RESTORE_WORD}” to confirm.`,
              status: current?.status ?? null,
            };
          }
          if (relaunching) return { ok: false, error: 'Commander is already relaunching.', status: null };
          return relaunchAfter(await relay({ op: 'restore', name: request.name }));
        }
        // The recovery screen's Restore: the snapshot the Core in its limited state offers.
        case 'recover':
          if (relaunching) return { ok: false, error: 'Commander is already relaunching.', status: null };
          return relaunchAfter(await relay({ op: 'recover' }));
        case 'export': {
          const chosen = await options.chooseFolder();
          if (!chosen) return relay({ op: 'status' });
          const checked = checkCopyFolder(chosen, options.userData, OWN_FOLDER);
          if (!checked.ok) {
            const current = await ask({ op: 'status' });
            return { ok: false, error: checked.error, status: current?.status ?? null };
          }
          return relay({ op: 'export', folder: checked.folder });
        }
      }
    },

    // A message from the Core. Returns true when it was a backups reply, handled here.
    settle(raw: unknown): boolean {
      const parsed = coreBackupsReply.safeParse(raw);
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
