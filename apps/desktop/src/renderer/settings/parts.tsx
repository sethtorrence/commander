import { cn } from '@commander/ui';
import { type ComponentProps, type ReactNode, useId } from 'react';

/** A numbered group on the Settings sheet, headed like the prototype's group headers (.gh). */
export function SettingsGroup({
  no,
  title,
  note,
  children,
  className,
  ...props
}: Omit<ComponentProps<'section'>, 'title'> & { no: string; title: string; note?: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn('[&+&]:mt-5.5 [&+&>h2]:border-t', className)} {...props}>
      <h2
        id={id}
        className="relative m-0 flex h-8 items-center gap-2.5 border-b border-line pr-5 pl-13 font-sans text-[12px] leading-none font-bold uppercase tracking-heading text-ink font-stretch-(--stretch-wider)"
      >
        <span className="absolute left-0 w-10 text-center font-mono text-label font-semibold tracking-normal text-muted">
          {no}
        </span>
        {title}
        {note && (
          <span className="ml-auto font-mono text-label-lg font-semibold tracking-label text-muted">
            {note}
          </span>
        )}
      </h2>
      {children}
    </section>
  );
}

/** One setting: what it is on the left, its control on the right. */
export function SettingRow({
  label,
  description,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,260px)_minmax(0,1fr)] items-start gap-6 border-b border-line2 py-3.5 pr-6 pl-13">
      <div className="min-w-0">
        <div className="text-row leading-[22px] font-semibold text-ink">{label}</div>
        {description && <div className="mt-1 text-note leading-[19px] text-muted">{description}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Mono label / value rows (.kv). */
export function Readout({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn('m-0 max-w-[560px] border-t border-line', className)}>{children}</dl>;
}

export function ReadoutRow({
  label,
  children,
  live,
}: {
  label: string;
  children: ReactNode;
  live?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex justify-between gap-2.5 border-b border-line2 py-[7px] font-mono text-label-lg leading-[1.3] uppercase tracking-tag',
        live && 'text-signal-ink',
      )}
    >
      <dt className={live ? '' : 'text-muted'}>{label}</dt>
      <dd className={cn('m-0 flex items-center gap-2 text-right font-semibold', !live && 'text-ink')}>
        {children}
      </dd>
    </div>
  );
}
