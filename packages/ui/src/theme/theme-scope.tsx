import { type ComponentProps, createContext, useContext, useState } from 'react';
import { cn } from '../lib/cn';
import type { Theme } from './themes';

const PortalContainerContext = createContext<HTMLElement | null>(null);

/**
 * Where overlays (dialogs, menus, tooltips) render. Inside a ThemeScope they render within the scope,
 * so they take its theme; elsewhere they go to the document body.
 */
export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext) ?? undefined;
}

/** Renders its children in one theme, whatever the app's theme is (used to show both side by side). */
export function ThemeScope({
  theme,
  className,
  children,
  ...props
}: ComponentProps<'div'> & { theme: Theme }) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  return (
    <div data-theme={theme} className={cn('bg-bg text-text', className)} {...props}>
      <PortalContainerContext.Provider value={container}>{children}</PortalContainerContext.Provider>
      <div ref={setContainer} />
    </div>
  );
}
