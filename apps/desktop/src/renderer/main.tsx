import './app.css';
import { AppearanceProvider, Toaster, TooltipProvider } from '@commander/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DesignGallery } from './gallery/DesignGallery';
import { useHashRoute } from './use-hash-route';

// Until the app frame (#40) brings Sections, screens are picked by the URL hash.
function Screen() {
  const route = useHashRoute();
  return route === '#/design' ? <DesignGallery /> : <App />;
}

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <AppearanceProvider>
        <TooltipProvider>
          <Screen />
          <Toaster />
        </TooltipProvider>
      </AppearanceProvider>
    </StrictMode>,
  );
