import { useEffect, useState } from 'react';
import type { CommanderBridge, Diagnostics } from '../preload';

declare global {
  interface Window {
    commander: CommanderBridge;
  }
}

// Placeholder shell until the Industrial design system and app frame land.
export function App() {
  const [beats, setBeats] = useState<number | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);

  useEffect(() => {
    window.commander.diagnostics().then(setDiag);
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
        display <span data-testid="display-server">{diag?.displayServer ?? '…'}</span> · keyring{' '}
        <span data-testid="password-store">{diag?.passwordStore ?? '…'}</span> · electron{' '}
        {diag?.electron ?? '…'}
      </p>
    </main>
  );
}
