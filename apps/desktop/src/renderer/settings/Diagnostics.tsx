import type { CoreStatus, Diagnostics as DiagnosticsInfo } from '@commander/domain';
import { Led } from '@commander/ui';
import { useEffect, useState } from 'react';
import { useCoreStatus } from '../frame/CoreBanner';
import { Readout, ReadoutRow, SettingRow, SettingsGroup } from './parts';

const hhmm = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

// How the Core's restarts read (#200): how many, and when and why it last stopped.
function restartsText(status: CoreStatus | null): string {
  if (!status) return '…';
  const { restarts, lastStop } = status;
  if (!lastStop) return 'None';
  const why =
    lastStop.reason === 'unresponsive'
      ? 'stopped answering'
      : `exited${lastStop.code !== null ? ` (code ${lastStop.code})` : ''}`;
  return `${restarts} · last ${why} at ${hhmm(lastStop.at)}`;
}

// Settings → Diagnostics: the Core's heartbeat and restarts, and how the window reaches the screen.
export function Diagnostics({ no }: { no: string }) {
  const [beats, setBeats] = useState<number | null>(null);
  const [info, setInfo] = useState<DiagnosticsInfo | null>(null);
  const core = useCoreStatus(window.commander);

  useEffect(() => {
    window.commander.diagnostics().then(setInfo);
    return window.commander.onCoreMessage((message) => {
      if (message.type === 'heartbeat') setBeats(message.beats);
    });
  }, []);

  return (
    <SettingsGroup
      no={no}
      title="Diagnostics"
      note={`Electron ${info?.electron ?? '…'}`}
      data-testid="diagnostics"
    >
      <SettingRow
        label="Core"
        description="The background process that keeps Commander running behind the window."
      >
        <Readout>
          <ReadoutRow label="Heartbeat" live={beats !== null}>
            {beats !== null && <Led size="sm" />}
            <span data-testid="core-heartbeat" className="tabular-nums">
              {beats ?? '…'}
            </span>
          </ReadoutRow>
          <ReadoutRow label="Restarts">
            <span data-testid="core-restarts">{restartsText(core)}</span>
          </ReadoutRow>
        </Readout>
      </SettingRow>
      <SettingRow label="Window" description="How the window reaches the screen, and where secrets are kept.">
        <Readout>
          <ReadoutRow label="Display">
            <span data-testid="display-server">{info?.displayServer ?? '…'}</span>
            <span className="font-medium text-muted">
              (<span data-testid="display-source">{info?.displaySource ?? '…'}</span>)
            </span>
          </ReadoutRow>
          <ReadoutRow label="Password store">
            <span data-testid="password-store">{info?.passwordStore ?? '…'}</span>
          </ReadoutRow>
          <ReadoutRow label="Electron">{info?.electron ?? '…'}</ReadoutRow>
        </Readout>
      </SettingRow>
    </SettingsGroup>
  );
}
