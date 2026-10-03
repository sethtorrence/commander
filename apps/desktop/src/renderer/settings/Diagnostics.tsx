import type { Diagnostics as DiagnosticsInfo } from '@commander/domain';
import { Led } from '@commander/ui';
import { useEffect, useState } from 'react';
import { Readout, ReadoutRow, SettingRow, SettingsGroup } from './parts';

// Settings → Diagnostics: the Core's heartbeat and how the window reaches the screen.
export function Diagnostics({ no }: { no: string }) {
  const [beats, setBeats] = useState<number | null>(null);
  const [info, setInfo] = useState<DiagnosticsInfo | null>(null);

  useEffect(() => {
    window.commander.diagnostics().then(setInfo);
    return window.commander.onCoreMessage((message) => {
      if (message.type === 'heartbeat') setBeats(message.beats);
    });
  }, []);

  return (
    <SettingsGroup no={no} title="Diagnostics" note={`Electron ${info?.electron ?? '…'}`}>
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
