import type { Diagnostics } from '@commander/domain';
import { useEffect, useState } from 'react';
import type { CommanderBridge } from '../preload';
import { SecurityPanel } from './SecurityPanel';
import { StartAtLogin } from './StartAtLogin';

declare global {
  interface Window {
    commander: CommanderBridge;
  }
}

// Placeholder shell until the Industrial design system and app frame land.
export function App() {
  const [beats, setBeats] = useState<number | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);

  useEffect(() => {
    window.commander.diagnostics().then(setDiagnostics);
    return window.commander.onCoreMessage((message) => {
      if (message.type === 'heartbeat') setBeats(message.beats);
    });
  }, []);

  return (
    <main style={{ padding: 32 }}>
      <h1 style={{ margin: 0, letterSpacing: '0.08em' }}>COMMANDER</h1>
      <p>
        Core heartbeat: <span data-testid="core-heartbeat">{beats ?? '…'}</span>
      </p>
      <p style={{ color: '#8f8d87', fontFamily: 'monospace' }}>
        display <span data-testid="display-server">{diagnostics?.displayServer ?? '…'}</span> (
        <span data-testid="display-source">{diagnostics?.displaySource ?? '…'}</span>) · keyring{' '}
        <span data-testid="password-store">{diagnostics?.passwordStore ?? '…'}</span> · electron{' '}
        {diagnostics?.electron ?? '…'}
      </p>
      <SecurityPanel />
      <StartAtLogin />
    </main>
  );
}
