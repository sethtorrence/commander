import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, CSSProperties } from 'react';
import { cn } from '../lib/cn';
import { type AccentName, accentColour } from '../projects/accents';

// A Badge is a Project's two-letter code stamped on its accent colour (.pb in the prototypes).
export const badgeVariants = cva(
  'inline-grid shrink-0 select-none place-items-center p-0 align-middle font-mono font-bold uppercase leading-none',
  {
    variants: {
      kind: {
        filled: 'bg-(--accent) text-on-accent',
        /** Ares's suggestion, not yet confirmed: a dashed outline. */
        suggested: 'border border-dashed border-(--accent) text-ink',
        /** No Project yet: a faint outline around a dash. */
        unfiled: 'font-medium text-faint shadow-[inset_0_0_0_1px_var(--faint)]',
      },
      size: {
        sm: 'h-[13px] w-5 text-[7.5px] tracking-[0.03em]',
        default: 'h-4 w-[25px] text-label tracking-badge',
        lg: 'h-[42px] w-[66px] text-[20px] tracking-[0.04em]',
      },
    },
    defaultVariants: { kind: 'filled', size: 'default' },
  },
);

export type BadgeProps = Omit<ComponentProps<'span'>, 'children'> &
  VariantProps<typeof badgeVariants> & {
    /** The Project's short code, e.g. `LT`. Ignored when unfiled. */
    code?: string;
    /** A palette accent name, or any CSS colour. */
    accent?: AccentName | (string & {});
    /** The Project's name, read out and shown on hover. */
    project?: string;
  };

export function Badge({ code, accent, project, kind, size, className, style, ...props }: BadgeProps) {
  const unfiled = kind === 'unfiled' || !code;
  const colour = accent && accentColour(accent);
  const label = unfiled ? 'Unfiled' : (project ?? code);
  return (
    <span
      data-slot="badge"
      role="img"
      aria-label={label}
      title={label}
      className={cn(badgeVariants({ kind: unfiled ? 'unfiled' : kind, size }), className)}
      style={{ '--accent': colour, ...style } as CSSProperties}
      {...props}
    >
      {unfiled ? '—' : code}
    </span>
  );
}
