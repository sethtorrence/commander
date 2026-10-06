/*
  Backups you can restore (#202), the Core's side of Settings → Data:

  - The daily snapshot, taken at start-up and checked hourly (item-store/snapshots.ts). A copy that
    fails its integrity check is discarded; the failure (and a failed pre-update snapshot) shows in
    Diagnostics and goes in Ares's queue for the next Update, until a later daily snapshot succeeds.
  - The snapshots listed, and a restore marked for the relaunch (restore.ts); a restore made at this
    start (or one that failed) is reported the same way.
  - Export everything into a folder the main process checked (export.ts), its progress pushed as it
    goes, and cancellable.
*/
import { rmSync } from 'node:fs';
import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  type BackupsStatus,
  type CoreBackupsReply,
  type CoreMessage,
  coreBackupsRequest,
  type Enqueue,
  type ExportProgress,
  type SnapshotProblem,
} from '@commander/domain';
import type { ItemStore } from '../item-store';
import { listSnapshots } from '../item-store/snapshots';
import { ExportCancelled, exportEverything } from './export';
import { markForRestore, type RestoreOutcome } from './restore';

export { applyPendingRestore, restoreSnapshot } from './restore';

type BackupFailure = Extract<Enqueue['about'], { kind: 'backup-failed' }>;

export type BackupsOptions = {
  store: ItemStore;
  dataDir: string;
  snapshotDir: string;
  attachmentsDir: string;
  send(message: CoreMessage | CoreBackupsReply): void;
  // What this start of the Core restored before opening the database, if anything.
  restored: RestoreOutcome | null;
  // Ares's queue, once it is set up: failures go in it, and a snapshot's line goes once one succeeds.
  queue(): { enqueue(input: Enqueue): unknown; resolve(id: number): unknown } | undefined;
  now?: () => number;
};

const IMPORTANCE = 0.8;
const PROGRESS_MS = 100;

export function setUpBackups(options: BackupsOptions) {
  const { store, send } = options;
  const now = options.now ?? Date.now;
  const problems = new Map<SnapshotProblem['kind'], SnapshotProblem>();
  let exporting: { progress: ExportProgress; abort: AbortController; work?: string } | null = null;
  let lastExport: ExportProgress | null = null;
  let sent: BackupsStatus | null = null;
  // Failures waiting for the queue (the first snapshot is taken before Ares's queue is set up).
  const unreported = new Map<BackupFailure['what'], BackupFailure>();

  const restored = options.restored?.ok
    ? { name: options.restored.name, at: options.restored.at, keptAside: options.restored.keptAside }
    : null;
  const restoreFailed = options.restored && !options.restored.ok ? options.restored.reason : null;

  function status(): BackupsStatus {
    return {
      snapshots: listSnapshots(options.snapshotDir),
      problems: [...problems.values()].sort((a, b) => b.at - a.at),
      restored: restored && { ...restored, keptAside: restored.keptAside && basename(restored.keptAside) },
      restoreFailed,
      export: exporting?.progress ?? lastExport,
    };
  }

  function changed() {
    const next = status();
    if (isDeepStrictEqual(next, sent)) return;
    sent = next;
    send({ type: 'backups-status', status: next });
  }

  function report(failure: BackupFailure) {
    unreported.set(failure.what, failure);
    flush();
  }

  function settle(what: BackupFailure['what']) {
    unreported.delete(what);
    const line = store.updates.queuedWithKey(`backup-failed:${what}`);
    if (line) options.queue()?.resolve(line.id);
  }

  function flush() {
    const queue = options.queue();
    if (!queue) return;
    for (const failure of unreported.values()) {
      queue.enqueue({
        group: 'fyi',
        mergeKey: `backup-failed:${failure.what}`,
        about: failure,
        itemIds: [],
        section: 'ares',
        importance: IMPORTANCE,
      });
    }
    unreported.clear();
  }

  // What opening the database found: a failed pre-update snapshot, a restore made or failed.
  const before = store.preUpdateSnapshot;
  if (before && !before.ok) {
    problems.set('before-update', { kind: 'before-update', at: before.at, reason: before.reason });
    report({ kind: 'backup-failed', what: 'update-snapshot', at: before.at, reason: before.reason });
  }
  if (options.restored && !options.restored.ok)
    report({
      kind: 'backup-failed',
      what: 'restore',
      at: options.restored.at,
      reason: options.restored.reason,
    });

  // An export's progress goes out at most every PROGRESS_MS, and at once when its step changes.
  let progressSentAt = 0;
  function setExport(progress: ExportProgress) {
    if (!exporting) return;
    const stepChanged = exporting.progress.step !== progress.step;
    exporting.progress = progress;
    const at = now();
    if (!stepChanged && progress.done < progress.total && at - progressSentAt < PROGRESS_MS) return;
    progressSentAt = at;
    changed();
  }

  async function runExport(into: string) {
    const abort = new AbortController();
    const startedAt = now();
    const progress: ExportProgress = {
      state: 'running',
      step: 'database',
      done: 0,
      total: 1,
      folder: null,
      error: null,
      startedAt,
    };
    exporting = { progress, abort };
    changed();
    try {
      const folder = await exportEverything({
        store,
        dataDir: options.dataDir,
        attachmentsDir: options.attachmentsDir,
        into,
        signal: abort.signal,
        now,
        onWorking: (work) => {
          if (exporting) exporting.work = work;
        },
        onProgress: (step, done, total) => setExport({ ...progress, step, done, total }),
      });
      lastExport = { ...(exporting?.progress ?? progress), state: 'done', folder };
    } catch (error) {
      const cancelled = error instanceof ExportCancelled;
      lastExport = {
        ...(exporting?.progress ?? progress),
        state: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? null : error instanceof Error ? error.message : String(error),
      };
    } finally {
      exporting = null;
      changed();
    }
  }

  return {
    /**
     * Today's snapshot, unless it was taken: a bad copy is discarded and reported, and the first good
     * one after a failure clears it. Never throws.
     */
    takeDaily() {
      try {
        const taken = store.takeDailySnapshot();
        if (taken) {
          problems.delete('daily');
          problems.delete('before-update');
          settle('daily-snapshot');
        }
      } catch (error) {
        const at = now();
        const reason = error instanceof Error ? error.message : String(error);
        console.warn('The daily snapshot failed:', reason);
        problems.set('daily', { kind: 'daily', at, reason });
        report({ kind: 'backup-failed', what: 'daily-snapshot', at, reason });
      }
      changed();
    },

    // Ares's queue is set up: the failures found before it go in now.
    queueReady: flush,

    status,

    /** Answers the main process's requests. False for any other message. */
    handle(raw: unknown): boolean {
      const parsed = coreBackupsRequest.safeParse(raw);
      if (!parsed.success) return false;
      const { id, request } = parsed.data;
      const reply = (response: CoreBackupsReply['response']) => send({ type: 'backups-reply', id, response });
      switch (request.op) {
        case 'status':
          reply({ ok: true, status: status() });
          break;
        case 'restore':
          try {
            markForRestore(options.dataDir, request.name);
            reply({ ok: true, status: status() });
          } catch (error) {
            reply({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              status: status(),
            });
          }
          break;
        case 'export':
          if (exporting) {
            reply({ ok: false, error: 'An export is already running.', status: status() });
            break;
          }
          void runExport(request.folder);
          reply({ ok: true, status: status() });
          break;
        case 'cancel-export':
          exporting?.abort.abort();
          reply({ ok: true, status: status() });
          break;
      }
      return true;
    },

    // The Core is stopping: an export can't finish, so its unfinished folder goes now.
    stop() {
      exporting?.abort.abort();
      if (exporting?.work) rmSync(exporting.work, { recursive: true, force: true });
    },
  };
}

export type Backups = ReturnType<typeof setUpBackups>;
