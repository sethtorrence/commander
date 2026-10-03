import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';
import { useAppearance } from '../theme/appearance-provider';
import { ThemeIcon } from './icons';

/** Switches light / dark (.tbx in the prototypes). Shows the current theme; the choice persists. */
export function ThemeToggle({ className, ...props }: ComponentProps<'button'>) {
  const { theme, toggleTheme } = useAppearance();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      data-slot="theme-toggle"
      aria-label={`Switch to ${next}`}
      title={`Switch to ${next}`}
      onClick={toggleTheme}
      className={cn(
        'flex h-7.5 cursor-pointer items-center gap-2 border border-line bg-transparent px-2.5',
        'font-mono text-label font-semibold uppercase leading-none tracking-caps text-muted',
        'hover:border-ink hover:text-ink',
        className,
      )}
      {...props}
    >
      <ThemeIcon />
      {theme === 'dark' ? 'Drk' : 'Lgt'}
    </button>
  );
}
