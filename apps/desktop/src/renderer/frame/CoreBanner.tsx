import { CORE_DOWN, type CoreStatus, DISK_FULL } from '@commander/domain';
import { Button, Led, toast } from '@commander/ui';
import { useEffect, useRef, useState } from 'react';
import { useOpenSettings } from '../sections/section';

export type CoreStatusBridge = {
  coreStatus(): Promise<CoreStatus>;
  onCoreStatus(listener: (status: CoreStatus) => void): () => void;
  restartCore(): Promise<void>;
};

/** Where Commander's core stands (#200): asked of the main process once, then kept up to date. */
export function useCoreStatus(bridge: Partial<CoreStatusBridge> | undefined): CoreStatus | null {
  const [status, setStatus] = useState<CoreStatus | null>(null);
  useEffect(() => {
    if (!bridge?.coreStatus || !bridge.onCoreStatus) return;
    let heard = false;
    const stop = bridge.onCoreStatus((next) => {
      heard = true;
      setStatus(next);
    });
    bridge.coreStatus().then(
      (next) => {
        if (!heard) setStatus(next);
      },
      () => {},
    );
    return stop;
  }, [bridge]);
  return status;
}

/**
 * The quiet banner while Commander's core is down (#200): "Starting it again…" while a new one is on
 * its way; once Commander has stopped trying (several stops in a short time), a plain error with Try
 * again and a link to Settings' Diagnostics page (settings/pages.ts). A toast says so when it is back.
 * The same place says when the disk is full (#203): the window holds the User's edits meanwhile, and
 * a toast says so when there is space again and they are being saved.
 */
export function CoreBanner({
  bridge = window.commander,
}: {
  bridge?: Partial<CoreStatusBridge> | undefined;
}) {
  const status = useCoreStatus(bridge);
  const openSettings = useOpenSettings();
  const [asking, setAsking] = useState(false);
  const wasDown = useRef(false);
  const wasFull = useRef(false);
  const diskFull = status?.state === 'running' && status.database?.state === 'disk-full';
  useEffect(() => {
    if (!status) return;
    if (status.state !== 'running') wasDown.current = true;
    else if (wasDown.current) {
      wasDown.current = false;
      toast('Commander’s core is running again.');
    }
    if (status.state !== 'stopped') setAsking(false);
    if (diskFull) wasFull.current = true;
    else if (wasFull.current && status.state === 'running') {
      wasFull.current = false;
      toast('There’s space again. Commander is saving your changes.');
    }
  }, [status, diskFull]);

  if (diskFull)
    return (
      <div
        role="alert"
        data-testid="core-banner"
        data-state="disk-full"
        className="fixed bottom-4 left-1/2 z-40 flex max-w-[calc(100vw-4rem)] -translate-x-1/2 items-center gap-3 border border-signal bg-sheet px-4 py-2.5 text-note text-ink"
      >
        <Led size="sm" state="on" />
        <span>{DISK_FULL}</span>
      </div>
    );
  if (!status || status.state === 'running') return null;
  const stopped = status.state === 'stopped';
  return (
    <div
      role="status"
      data-testid="core-banner"
      data-state={status.state}
      className="fixed bottom-4 left-1/2 z-40 flex max-w-[calc(100vw-4rem)] -translate-x-1/2 items-center gap-3 border border-line bg-sheet px-4 py-2.5 text-note text-ink"
    >
      <Led size="sm" state={stopped ? 'off' : 'muted'} />
      <span>{stopped ? CORE_DOWN.stopped : CORE_DOWN.restarting}</span>
      {stopped && (
        <>
          <Button
            size="sm"
            variant="primary"
            disabled={asking}
            onClick={() => {
              setAsking(true);
              bridge?.restartCore?.().catch(() => setAsking(false));
            }}
          >
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={() => openSettings({ page: 'diagnostics' })}>
            Diagnostics
          </Button>
        </>
      )}
    </div>
  );
}
