import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn';
import { usePortalContainer } from '../theme/theme-scope';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

// A dialog is a sheet laid over the drawing: hard ink border, title strip, no shadow, no rounding.
export function DialogContent({
  className,
  overlayClassName,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { overlayClassName?: string }) {
  return (
    <DialogPrimitive.Portal container={usePortalContainer()}>
      <DialogPrimitive.Overlay
        data-slot="dialog-overlay"
        className={cn(
          'fixed inset-0 z-50 bg-[color-mix(in_srgb,var(--bg)_72%,transparent)]',
          overlayClassName,
        )}
      />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-50 w-[min(520px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2',
          'border border-ink bg-sheet text-text outline-none',
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/** The title strip: part number on ink, the title, and Close (Esc). */
export function DialogHeader({
  partNumber,
  className,
  children,
  ...props
}: ComponentProps<'div'> & { partNumber?: ReactNode }) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        'flex h-7.5 items-stretch border-b border-line font-mono text-label-lg uppercase leading-none tracking-label text-muted',
        className,
      )}
      {...props}
    >
      {partNumber && (
        <span className="flex items-center bg-ink px-3 font-semibold text-sheet">{partNumber}</span>
      )}
      <span className="flex min-w-0 flex-1 items-center px-3">{children}</span>
      <DialogPrimitive.Close className="flex cursor-pointer items-center gap-2 border-l border-line2 pr-1.5 pl-3 font-semibold uppercase tracking-label text-muted hover:bg-raise hover:text-ink">
        Close <kbd className="h-4.5 min-w-0 text-label">Esc</kbd>
      </DialogPrimitive.Close>
    </div>
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('m-0 truncate font-mono text-label-lg font-semibold text-ink', className)}
      {...props}
    />
  );
}

export function DialogBody({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="dialog-body" className={cn('px-6.5 pt-5.5 pb-6', className)} {...props} />;
}

export function DialogHeading({ className, ...props }: ComponentProps<'h2'>) {
  return (
    <h2
      className={cn(
        'm-0 font-sans text-subtitle leading-[1.05] font-extrabold tracking-display text-ink font-stretch-(--stretch-wide)',
        className,
      )}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('mt-3 text-row leading-[1.55] text-text', className)}
      {...props}
    />
  );
}

/** Actions sit in a ruled row along the bottom edge, like the margin cards' Accept / Dismiss. */
export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'flex justify-end gap-0 border-t border-line2 px-6.5 py-3.5 [&>*+*]:border-l-0',
        className,
      )}
      {...props}
    />
  );
}
