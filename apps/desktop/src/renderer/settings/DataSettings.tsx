import {
  type BackupsRequest,
  type BackupsStatus,
  confirmsRestore,
  type ExportProgress,
  RESTORE_WORD,
  type SnapshotInfo,
  type SnapshotKind,
  type SnapshotProblem,
} from '@commander/domain';
import { Button, Input } from '@commander/ui';
import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { MarkdownCopySetting } from '../sections/notes/MarkdownCopySetting';
import { SettingRow, SettingsGroup } from './parts';

/*
  Settings → Data (#199, #202): what Commander keeps of the User's data besides the database itself.
  The snapshots the Core makes (item-store/snapshots.ts), each restorable after typed confirmation
  (Commander relaunches to make the restore); Export everything into a folder from the system picker,
  with its progress and Cancel; and the Markdown copy of the Daily Notes.
*/

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Tue 6 Oct 2026", from a local day (YYYY-MM-DD). */
export function dayLabel(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const weekday = new Date(year, month - 1, date).getDay();
  return `${WEEKDAYS[weekday]} ${date} ${MONTHS[month - 1]} ${year}`;
}

/** "48 KB", "12.4 MB", "1.2 GB". */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export const KIND_LABELS: Record<SnapshotKind, string> = {
  daily: 'Daily',
  'before-update': 'Before update',
  'before-restore': 'Before restore',
};

const whenOf = (snapshot: Pick<SnapshotInfo, 'day' | 'time'>) =>
  `${dayLabel(snapshot.day)}${snapshot.time ? ` · ${snapshot.time}` : ''}`;

/** A snapshot by its file name, in words: "the before-update snapshot of Tue 6 Oct 2026 · 14:32". */
export function snapshotLabel(name: string): string {
  const parsed =
    /^commander-(?:(before-update|before-restore)-)?(\d{4}-\d{2}-\d{2})(?:-(\d{2})(\d{2})\d{2})?\.db$/.exec(
      name,
    );
  if (!parsed) return name;
  const kind = (parsed[1] ?? 'daily') as SnapshotKind;
  const time = parsed[3] ? `${parsed[3]}:${parsed[4]}` : null;
  return `the ${KIND_LABELS[kind].toLowerCase()} snapshot of ${whenOf({ day: parsed[2] as string, time })}`;
}

const hhmm = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

const PROBLEM_WORDS: Record<SnapshotKind, string> = {
  daily: 'Today’s snapshot',
  'before-update': 'The snapshot before this update',
  'before-restore': 'The snapshot before the restore',
};

/** A snapshot that failed, as one sentence. */
export const problemText = (problem: SnapshotProblem) =>
  `${PROBLEM_WORDS[problem.kind]} failed at ${hhmm(problem.at)} and was discarded; the older snapshots are all kept. ${problem.reason}`;

/** The Core's backups as they stand, and asking it: the snapshots and Export everything share it. */
export function useBackups() {
  const [status, setStatus] = useState<BackupsStatus | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [relaunching, setRelaunching] = useState(false);
  const [busy, setBusy] = useState(false);

  const ask = useCallback(async (request: BackupsRequest) => {
    setBusy(true);
    try {
      const response = await window.commander.backups(request);
      if (response.status) setStatus(response.status);
      setRefused(response.ok ? null : response.error);
      if (response.ok && response.relaunching) setRelaunching(true);
      return response.ok;
    } catch (error) {
      setRefused(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void ask({ op: 'status' });
    return window.commander.onCoreMessage((message) => {
      if (message.type === 'backups-status') setStatus(message.status);
      // A new Core after one stopped: ask again, its word may not have come.
      if (message.type === 'core-restarted') void ask({ op: 'status' });
    });
  }, [ask]);

  return { status, refused, relaunching, busy, ask };
}

function Notice({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <p
      data-testid={testId}
      role="alert"
      className="m-0 mt-3 max-w-[560px] border-l-2 border-signal py-0.5 pl-3.5 text-note leading-[19px] text-ink"
    >
      {children}
    </p>
  );
}

function Note({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <p
      data-testid={testId}
      className="m-0 mt-3 max-w-[560px] border-l-2 border-line py-0.5 pl-3.5 text-note leading-[19px] text-muted"
    >
      {children}
    </p>
  );
}

/** Restore's typed confirmation, under the snapshot chosen. */
function RestoreConfirm({
  snapshot,
  busy,
  onRestore,
  onCancel,
}: {
  snapshot: SnapshotInfo;
  busy: boolean;
  onRestore: (typed: string) => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState('');
  const id = useId();
  const ready = confirmsRestore(typed);
  return (
    <form
      data-testid="restore-confirm"
      className="border-b border-line2 bg-raise px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onRestore(typed);
      }}
    >
      <p className="m-0 text-note leading-[19px] text-ink">
        Restore the {KIND_LABELS[snapshot.kind].toLowerCase()} snapshot of {whenOf(snapshot)}? Commander keeps
        the database as it is now aside as a “before restore” snapshot, swaps this one in with its pasted
        images, and relaunches. Anything written in Commander since then is only in the before-restore
        snapshot; each Source catches up as it syncs.
      </p>
      <label htmlFor={id} className="mt-3 block text-note text-muted">
        Type <code className="font-mono text-ink">{RESTORE_WORD}</code> to confirm
      </label>
      <div className="mt-1.5 flex gap-2">
        <Input
          id={id}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          className="max-w-[200px]"
        />
        <Button type="submit" variant="primary" disabled={!ready || busy}>
          Restore and relaunch
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Snapshots: the database copies the Core makes, each restorable. */
export function SnapshotSettings({ no }: { no: string }) {
  const { status, refused, relaunching, busy, ask } = useBackups();
  const [chosen, setChosen] = useState<string | null>(null);
  const snapshots = status?.snapshots ?? [];
  const chosenSnapshot = snapshots.find((snapshot) => snapshot.name === chosen) ?? null;

  return (
    <SettingsGroup no={no} title="Snapshots" note="Daily · last 7 kept">
      <SettingRow
        label="Snapshots"
        description="Copies of the database in the snapshots folder beside it: one each day Commander runs (checked hourly), one before each update that changes the database, and one before each restore. Each is checked before it replaces an older one."
      >
        <div data-testid="snapshots-setting" className="max-w-[560px]">
          {!status ? (
            <p className="m-0 text-note text-muted">…</p>
          ) : snapshots.length === 0 ? (
            <p data-testid="snapshots-empty" className="m-0 text-note text-muted">
              None yet. Commander makes the first one when it starts.
            </p>
          ) : (
            <ul className="m-0 list-none border-t border-line p-0" aria-label="Snapshots">
              {snapshots.map((snapshot) => (
                <li key={snapshot.name} data-testid="snapshot" data-snapshot={snapshot.name}>
                  <div className="flex items-center gap-3 border-b border-line2 py-[7px] font-mono text-label-lg leading-[1.3] tracking-tag">
                    <span data-testid="snapshot-when" className="min-w-0 flex-1 font-semibold text-ink">
                      {whenOf(snapshot)}
                    </span>
                    <span data-testid="snapshot-kind" className="w-[110px] uppercase text-muted">
                      {KIND_LABELS[snapshot.kind]}
                    </span>
                    <span data-testid="snapshot-size" className="w-[64px] text-right tabular-nums text-muted">
                      {sizeLabel(snapshot.size)}
                    </span>
                    <Button
                      size="sm"
                      aria-label={`Restore ${whenOf(snapshot)}`}
                      disabled={busy || relaunching || chosen === snapshot.name}
                      onClick={() => setChosen(snapshot.name)}
                    >
                      Restore…
                    </Button>
                  </div>
                  {chosenSnapshot?.name === snapshot.name && !relaunching && (
                    <RestoreConfirm
                      snapshot={chosenSnapshot}
                      busy={busy}
                      onCancel={() => setChosen(null)}
                      onRestore={(typed) =>
                        void ask({ op: 'restore', name: snapshot.name, confirmation: typed }).then((ok) => {
                          if (!ok) return;
                          setChosen(null);
                        })
                      }
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          {relaunching && (
            <Note testId="restore-relaunching">Restoring… Commander is relaunching with the snapshot.</Note>
          )}
          {status?.restored && (
            <Note testId="restore-done">
              Restored {snapshotLabel(status.restored.name)}.
              {status.restored.keptAside
                ? ` The database as it was is kept as ${snapshotLabel(status.restored.keptAside)}, above.`
                : ''}{' '}
              Each Source catches up as it syncs; changes that were waiting to reach a Source are held as
              Couldn’t sync, to check before you Retry.
            </Note>
          )}
          {status?.restoreFailed && (
            <Notice testId="restore-failed">
              The restore couldn’t be made, so the database is as it was. {status.restoreFailed}
            </Notice>
          )}
          {status?.problems.map((problem) => (
            <Notice key={problem.kind} testId="snapshot-problem">
              {problemText(problem)}
            </Notice>
          ))}
          {refused && <Notice testId="backups-refused">{refused}</Notice>}
        </div>
      </SettingRow>
    </SettingsGroup>
  );
}

const STEP_WORDS: Record<ExportProgress['step'], string> = {
  database: 'Copying the database',
  'daily-notes': 'Writing the Daily Notes',
  images: 'Copying pasted images',
  attachments: 'Copying attachments',
  readme: 'Writing the README',
};

/** Where a running export is, in words: "Writing the Daily Notes · 12 of 140". */
export const progressText = (progress: ExportProgress) =>
  `${STEP_WORDS[progress.step]}${progress.total > 1 ? ` · ${progress.done} of ${progress.total}` : ''}`;

/** Export everything: a copy of all of it, into a folder the User picks. */
export function ExportSettings({ no }: { no: string }) {
  const { status, refused, busy, ask } = useBackups();
  const progress = status?.export ?? null;
  const running = progress?.state === 'running';
  return (
    <SettingsGroup no={no} title="Export" note="Never secrets">
      <SettingRow
        label="Export everything"
        description="A copy of everything Commander holds, in a new folder inside the one you choose: the database, the Daily Notes as Markdown, pasted images and cached attachments, with a README saying what each part is. Never your sign-ins, tokens or keys."
      >
        <div data-testid="export-setting" className="max-w-[560px]">
          <div className="flex gap-2">
            <Button disabled={busy || running || !status} onClick={() => void ask({ op: 'export' })}>
              Export everything…
            </Button>
            {running && (
              <Button disabled={busy} onClick={() => void ask({ op: 'cancel-export' })}>
                Cancel
              </Button>
            )}
          </div>
          {running && progress && (
            <div data-testid="export-progress" className="mt-3">
              <p data-testid="export-step" className="m-0 text-note text-ink">
                {progressText(progress)}
              </p>
              <div className="mt-1.5 h-1 w-full bg-line2">
                <div
                  role="progressbar"
                  aria-label="Export progress"
                  aria-valuemin={0}
                  aria-valuemax={progress.total || 1}
                  aria-valuenow={progress.done}
                  className="h-full bg-ink"
                  style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}
          {progress?.state === 'done' && progress.folder && (
            <Note testId="export-done">
              Exported to{' '}
              <code data-testid="export-folder" className="font-mono break-all text-ink">
                {progress.folder}
              </code>
            </Note>
          )}
          {progress?.state === 'cancelled' && (
            <Note testId="export-cancelled">Export cancelled. Nothing was left in the folder.</Note>
          )}
          {progress?.state === 'failed' && (
            <Notice testId="export-failed">
              The export failed, and nothing was left in the folder. {progress.error}
            </Notice>
          )}
          {refused && <Notice testId="export-refused">{refused}</Notice>}
        </div>
      </SettingRow>
    </SettingsGroup>
  );
}

/** The Markdown copy of the Daily Notes, for Obsidian, grep and backups. */
export function MarkdownCopySettings({ no }: { no: string }) {
  return (
    <SettingsGroup no={no} title="Markdown copy" note="Daily Notes · read-only">
      <MarkdownCopySetting />
    </SettingsGroup>
  );
}
