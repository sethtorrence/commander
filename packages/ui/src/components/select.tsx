import { Select as SelectPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';
import { usePortalContainer } from '../theme/theme-scope';
import { CheckIcon, ChevronIcon } from './icons';

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        'flex h-7.5 w-full min-w-0 cursor-pointer items-center justify-between gap-2.5 border border-line bg-sheet px-2.5',
        'font-mono text-label-lg font-semibold uppercase leading-none tracking-label text-ink whitespace-nowrap',
        'hover:border-muted data-[state=open]:border-ink data-placeholder:text-faint',
        'disabled:cursor-not-allowed disabled:opacity-40 [&>span]:truncate',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronIcon className="shrink-0 text-muted" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

// The option list follows the prototypes' pop-ups (.acpop, .pk): sheet colour, a hard ink border.
export function SelectContent({
  className,
  children,
  position = 'popper',
  sideOffset = 4,
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal container={usePortalContainer()}>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        sideOffset={sideOffset}
        className={cn(
          'relative z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-y-auto',
          'border border-ink bg-sheet text-text',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectLabel({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn(
        'flex h-6.5 items-center border-b border-line px-2.5 font-mono text-label font-semibold uppercase leading-none tracking-caps text-muted',
        className,
      )}
      {...props}
    />
  );
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2.5 py-1.5 pr-8 pl-2.5 text-heading leading-5 text-text outline-none',
        'data-highlighted:bg-ink data-highlighted:text-sheet data-[state=checked]:shadow-[inset_3px_0_0_var(--ink)]',
        'data-disabled:pointer-events-none data-disabled:text-faint',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2.5 flex items-center">
        <CheckIcon />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export function SelectSeparator({ className, ...props }: ComponentProps<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className={cn('h-px bg-line2', className)} {...props} />;
}
