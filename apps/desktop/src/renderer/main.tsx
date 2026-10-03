import './app.css';
import { AppearanceProvider, Toaster, TooltipProvider } from '@commander/ui';
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Frame } from './frame/Frame';
import { DesignGallery } from './gallery/DesignGallery';
import { ShortcutProvider } from './shortcuts/react';
import { useHashRoute } from './use-hash-route';

// The design gallery has its own route (#/design, linked from Settings); everything else is the frame.
function Screen() {
  const route = useHashRoute();
  return route === '#/design' ? <DesignGallery /> : <Frame />;
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
          <Screen />
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
