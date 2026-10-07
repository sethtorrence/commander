import type { DatabaseRecovery, SnapshotInfo } from '@commander/domain';
import { Button, DrawingGrid, Led } from '@commander/ui';
import { type ReactNode, useState } from 'react';
import { dayLabel, KIND_LABELS, progressText, useBackups, WipeConfirm } from '../settings/DataSettings';

/*
  The recovery screen (#203), shown instead of Commander while the Core is in its limited state
  (core-supervisor.ts): it couldn't open the database, so nothing else can run.

  - Damaged: the database failed its check on start. Restore the latest good snapshot (the newest
    that passes the check), or Quit.
  - Failed update: one of this version's migrations failed, and the database is as it was. Restore
    the pre-update snapshot, Export everything, or Quit.

  Restore needs no typed confirmation here (the database as it is goes aside as a snapshot first, as
  with every restore) and relaunches Commander, through Settings → Data's backups channel
  (backups-channel.ts, `recover`). Export everything shows its progress as it does there. Wipe all
  Commander data (#204) is here too, with its typed confirmation: starting again as new is a fair
  answer to a damaged database. (Where the Markdown copy is written is in that database, so it isn't
  offered for deleting.)
*/

export type RecoveryBridge = { quit(): Promise<void> };

const whenOf = (snapshot: SnapshotInfo) =>
  `${dayLabel(snapshot.day)}${snapshot.time ? ` · ${snapshot.time}` : ''}`;

function Para({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p data-testid={testId} className="m-0 mt-3 max-w-[620px] text-note leading-[20px] text-ink">
      {children}
    </p>
  );
}

function Notice({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <p
      data-testid={testId}
      role="alert"
      className="m-0 mt-4 max-w-[620px] border-l-2 border-signal py-0.5 pl-3.5 text-note leading-[19px] text-ink"
    >
      {children}
    </p>
  );
}

function Detail({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <div className="mt-4 max-w-[620px] border-t border-line pt-2.5">
      <div className="font-mono text-label uppercase tracking-label text-muted">{label}</div>
      <code data-testid={testId} className="mt-1 block font-mono text-note break-words text-ink">
        {children}
      </code>
    </div>
  );
}

export function RecoveryScreen({
  health,
  bridge = window.commander,
}: {
  health: DatabaseRecovery;
  bridge?: RecoveryBridge;
}) {
  const { status, refused, relaunching, busy, ask } = useBackups();
  const [wiping, setWiping] = useState(false);
  const damaged = health.state === 'damaged';
  const snapshot = health.snapshot;
  const progress = status?.export ?? null;
  const exporting = progress?.state === 'running';
  const snapshotWords = snapshot
    ? `the ${KIND_LABELS[snapshot.kind].toLowerCase()} snapshot of ${whenOf(snapshot)}`
    : null;

  return (
    <main
      data-testid="recovery-screen"
      data-state={health.state}
      className="relative min-h-screen bg-bg text-ink"
      aria-labelledby="recovery-title"
    >
      <DrawingGrid className="fixed inset-0" />
      <div className="f-recovery-bar fixed inset-x-0 top-0 h-8" aria-hidden="true" />
      <section className="relative mx-auto max-w-[760px] px-10 pt-24 pb-16">
        <div className="flex items-center gap-2 font-mono text-label uppercase tracking-label text-muted">
          <Led size="sm" state="on" />
          Commander · Database
        </div>
        <h1
          id="recovery-title"
          className="m-0 mt-3 text-subtitle font-semibold leading-tight tracking-display"
        >
          {damaged ? 'Commander’s database is damaged' : 'Commander couldn’t update its database'}
        </h1>

        {damaged ? (
          <>
            <Para>
              Commander checks its database each time it starts. This time the check failed, so it stopped
              before reading or changing anything.
            </Para>
            {snapshotWords ? (
              <Para testId="recovery-offer">
                Restore brings back {snapshotWords}, the newest snapshot that passes the check. Anything
                written in Commander since then is lost, though the damaged database is kept aside as a
                snapshot; each Source catches up as it syncs.
              </Para>
            ) : (
              <Para testId="recovery-offer">
                No snapshot passes the check, so there is nothing to restore. The damaged database is left as
                it is in Commander’s data folder (commander.db).
              </Para>
            )}
            <Detail label="What the check found" testId="recovery-problem">
              {health.problem}
            </Detail>
          </>
        ) : (
          <>
            <Para>
              This version of Commander needed to update its database, and the update failed. Nothing was
              changed: your data is as the previous version left it, and that version can still open it.
            </Para>
            {snapshotWords ? (
              <Para testId="recovery-offer">
                Restore brings back the snapshot taken just before the update ({snapshot && whenOf(snapshot)}
                ). Export everything copies all your data to a folder you choose.
              </Para>
            ) : (
              <Para testId="recovery-offer">
                {health.snapshotProblem
                  ? `The snapshot before the update couldn’t be taken: ${health.snapshotProblem}`
                  : 'There is no snapshot from before the update.'}{' '}
                Export everything copies all your data to a folder you choose.
              </Para>
            )}
            <Detail label={`What failed · ${health.migration}`} testId="recovery-problem">
              {health.reason}
            </Detail>
          </>
        )}

        {health.restoreFailed && (
          <Notice testId="recovery-restore-failed">
            The restore you chose couldn’t be made, so the database is as it was. {health.restoreFailed}
          </Notice>
        )}

        <div className="mt-6 flex flex-wrap gap-2">
          {snapshot && (
            <Button
              variant="primary"
              size="lg"
              disabled={busy || relaunching || exporting}
              onClick={() => void ask({ op: 'recover' })}
            >
              {damaged ? 'Restore the latest good snapshot' : 'Restore the pre-update snapshot'}
            </Button>
          )}
          {!damaged && (
            <Button
              size="lg"
              disabled={busy || relaunching || exporting}
              onClick={() => void ask({ op: 'export' })}
            >
              Export everything…
            </Button>
          )}
          {exporting && (
            <Button size="lg" disabled={busy} onClick={() => void ask({ op: 'cancel-export' })}>
              Cancel export
            </Button>
          )}
          <Button
            size="lg"
            disabled={busy || relaunching || exporting || wiping}
            onClick={() => setWiping(true)}
          >
            Wipe all Commander data…
          </Button>
          <Button
            size="lg"
            variant={snapshot || !damaged ? 'default' : 'primary'}
            onClick={() => void bridge.quit()}
          >
            Quit
          </Button>
        </div>

        {wiping && <WipeConfirm markdownCopyFolder={null} onCancel={() => setWiping(false)} />}

        {relaunching && (
          <Para testId="recovery-relaunching">Restoring… Commander is relaunching with the snapshot.</Para>
        )}
        {exporting && progress && <Para testId="recovery-export-step">{progressText(progress)}</Para>}
        {progress?.state === 'done' && progress.folder && (
          <Para testId="recovery-export-done">
            Exported to <code className="font-mono break-all">{progress.folder}</code>
          </Para>
        )}
        {progress?.state === 'failed' && (
          <Notice testId="recovery-export-failed">
            The export failed, and nothing was left in the folder. {progress.error}
          </Notice>
        )}
        {refused && <Notice testId="recovery-refused">{refused}</Notice>}
      </section>
    </main>
  );
}
