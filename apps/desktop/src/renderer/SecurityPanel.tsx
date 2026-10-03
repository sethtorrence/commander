import type { SecretStorageStatus } from '@commander/domain';
import { useEffect, useState } from 'react';

const backendNames: Record<string, string> = {
  gnome_libsecret: 'GNOME Keyring / Secret Service (libsecret)',
  kwallet: 'KWallet',
  kwallet5: 'KWallet 5',
  kwallet6: 'KWallet 6',
  basic_text: 'None (plain text)',
  keychain: 'macOS Keychain',
  dpapi: 'Windows Data Protection',
};

// Settings → Security. Minimal until the app frame (#40) gives it a home in Settings.
export function SecurityPanel() {
  const [status, setStatus] = useState<SecretStorageStatus | null>(null);

  useEffect(() => {
    window.commander.secretStorageStatus().then(setStatus);
  }, []);

  return (
    <section data-testid="security-panel" aria-labelledby="security-heading" style={{ marginTop: 32 }}>
      <h2 id="security-heading" style={{ fontSize: 16, letterSpacing: '0.08em' }}>
        SECURITY
      </h2>
      <p>
        Secret storage: {status ? (backendNames[status.backend] ?? status.backend) : '…'} (
        <code data-testid="security-backend">{status?.backend ?? '…'}</code>)
      </p>
      <p>
        Sign-ins and API keys:{' '}
        <strong data-testid="security-protected" style={{ color: status?.protected ? '#7fb07f' : '#e07a5f' }}>
          {status ? (status.protected ? 'Protected by the system keyring' : 'Not protected') : '…'}
        </strong>
      </p>
      {status?.problem && (
        <p data-testid="security-problem" role="alert" style={{ maxWidth: 640 }}>
          {status.problem}
        </p>
      )}
    </section>
  );
}
