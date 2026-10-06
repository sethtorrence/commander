import { cn } from '@commander/ui';
import type { ReactNode } from 'react';
import { useOpenSettings } from '../sections/section';
import type { SettingsPlace } from './pages';

/**
 * Words in running text that open Settings at a page or group: "Connect one in Settings → Accounts".
 * Inside Settings it just changes page.
 */
export function SettingsLink({
  to,
  children,
  className,
}: {
  to: SettingsPlace;
  children: ReactNode;
  className?: string;
}) {
  const openSettings = useOpenSettings();
  return (
    <button
      type="button"
      onClick={() => openSettings(to)}
      className={cn(
        'cursor-pointer border-0 bg-transparent p-0 text-ink underline decoration-line underline-offset-2 [font:inherit] hover:decoration-ink',
        className,
      )}
    >
      {children}
    </button>
  );
}
