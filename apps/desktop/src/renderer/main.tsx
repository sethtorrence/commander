import './app.css';
import { type CoreStatus, needsRecovery } from '@commander/domain';
import { AppearanceProvider, Toaster, TooltipProvider } from '@commander/ui';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useCoreStatus } from './frame/CoreBanner';
import { Frame } from './frame/Frame';
import { RecoveryScreen } from './frame/RecoveryScreen';
import { DesignGallery } from './gallery/DesignGallery';
import { CommandProvider } from './palette/commands';
import { ShortcutProvider } from './shortcuts/react';
import { useHashRoute } from './use-hash-route';

/**
 * Whether the Core has said how the database is (#203), or is down (its banner says so): until then
 * the frame waits, so nothing asks a Core that may turn out not to have opened the database. Once
 * true it stays true, so a Core starting again never takes the frame (and the edits it holds) away.
 */
function useDatabaseKnown(status: CoreStatus | null): boolean {
  const [known, setKnown] = useState(false);
  const now = !!status && (status.state !== 'running' || status.database !== null);
  useEffect(() => {
    if (now) setKnown(true);
  }, [now]);
  return known || now;
}

// The design gallery has its own route (#/design, linked from Settings); everything else is the frame,
// unless the Core couldn't open the database (#203): then the recovery screen is all there is.
function Screen() {
  const route = useHashRoute();
  const status = useCoreStatus(window.commander);
  const known = useDatabaseKnown(status);
  if (route === '#/design') return <DesignGallery />;
  if (needsRecovery(status?.database)) return <RecoveryScreen health={status.database} />;
  return known ? <Frame /> : null;
}

// The window stays hidden until its first frame, already in the User's theme, is on screen.
function useFramePainted() {
  useEffect(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => window.commander.framePainted()));
  }, []);
}

function Root() {
  useFramePainted();
  return (
    <AppearanceProvider>
      <TooltipProvider>
        <ShortcutProvider>
          <CommandProvider>
            <Screen />
          </CommandProvider>
        </ShortcutProvider>
        <Toaster />
      </TooltipProvider>
    </AppearanceProvider>
  );
}

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
