import type { ComponentProps, ReactNode } from 'react';
import { Toaster as Sonner, toast } from 'sonner';
import { cn } from '../lib/cn';

export { toast };

// The prototypes' toast: an ink slab with a signal-coloured left edge and a boxed mono action.
const TOAST = [
  'flex w-full max-w-[400px] items-center gap-3.5 border-l-4 border-signal bg-ink py-2.5 pr-3 pl-3.5',
  'font-sans text-note leading-[18px] text-bg [&_b]:font-bold',
].join(' ');
const TOAST_ACTION = [
  'h-6.5 shrink-0 cursor-pointer border border-current bg-transparent px-2.5',
  'font-mono text-label-lg font-semibold uppercase leading-none tracking-caps text-inherit',
  'hover:border-signal hover:bg-signal hover:text-on-signal',
].join(' ');

/** Renders toasts raised with `toast(...)`. Mount once, near the root. */
export function Toaster(props: ComponentProps<typeof Sonner>) {
  return (
    <Sonner
      position="bottom-left"
      offset={{ left: 34, bottom: 16 }}
      gap={8}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: TOAST,
          content: 'flex min-w-0 flex-1 flex-col',
          description: 'text-small opacity-75',
          actionButton: TOAST_ACTION,
          cancelButton: TOAST_ACTION,
        },
      }}
      {...props}
    />
  );
}

/** A toast as a still, for the design gallery and documentation. */
export function ToastView({
  children,
  action,
  className,
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div role="status" className={cn(TOAST, className)}>
      <span className="min-w-0 flex-1">{children}</span>
      {action && (
        <button type="button" className={TOAST_ACTION}>
          {action}
        </button>
      )}
    </div>
  );
}
