import { Tooltip as TooltipPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';
import { usePortalContainer } from '../theme/theme-scope';

export function TooltipProvider({
  delayDuration = 300,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />;
}

export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

// The Section rail's tooltip (.ri::after): an ink block with mono caps, no arrow, no fade.
export function TooltipContent({
  className,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal container={usePortalContainer()}>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'z-50 bg-ink px-2.5 py-2 font-mono text-kbd font-semibold uppercase leading-none tracking-tag whitespace-nowrap text-bg',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
