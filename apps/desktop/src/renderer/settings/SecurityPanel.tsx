import type { SecretStorageStatus } from '@commander/domain';
import { Led } from '@commander/ui';
import { useEffect, useState } from 'react';
import { Readout, ReadoutRow, SettingRow, SettingsGroup } from './parts';

const backendNames: Record<string, string> = {
  gnome_libsecret: 'GNOME Keyring / Secret Service (libsecret)',
  kwallet: 'KWallet',
  kwallet5: 'KWallet 5',
  kwallet6: 'KWallet 6',
  basic_text: 'None (plain text)',
  keychain: 'macOS Keychain',
  dpapi: 'Windows Data Protection',
};

// Settings → Security: whether Account sign-ins and API keys are protected by the system keyring.
export function SecurityPanel({ no }: { no: string }) {
  const [status, setStatus] = useState<SecretStorageStatus | null>(null);

  useEffect(() => {
    window.commander.secretStorageStatus().then(setStatus);
  }, []);

  return (
    <SettingsGroup no={no} title="Security" note="Sign-ins and API keys" data-testid="security-panel">
      <SettingRow
        label="Secret storage"
        description="Account sign-ins and API keys are kept in the system keyring, never in plain files."
      >
        <Readout>
          <ReadoutRow label="Keyring">
            <span className="normal-case tracking-normal">
              {status ? (backendNames[status.backend] ?? status.backend) : '…'}
            </span>
          </ReadoutRow>
          <ReadoutRow label="Backend">
            <code data-testid="security-backend" className="font-mono normal-case">
              {status?.backend ?? '…'}
            </code>
          </ReadoutRow>
          <ReadoutRow label="Sign-ins and API keys" live={status ? !status.protected : false}>
            {status && <Led size="sm" state={status.protected ? 'muted' : 'on'} />}
            <span data-testid="security-protected" className="normal-case tracking-normal">
              {status ? (status.protected ? 'Protected by the system keyring' : 'Not protected') : '…'}
            </span>
          </ReadoutRow>
        </Readout>
        {status?.problem && (
          <p
            data-testid="security-problem"
            role="alert"
            className="m-0 mt-3 max-w-[560px] border-l-2 border-signal py-0.5 pl-3.5 text-note leading-[19px] text-ink"
          >
            {status.problem}
          </p>
        )}
      </SettingRow>
    </SettingsGroup>
  );
}
