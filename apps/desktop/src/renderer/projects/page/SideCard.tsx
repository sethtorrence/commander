import type { ReactNode } from 'react';

/** A card in a page's side column (.card), headed by a ruled mono strip (.lt). */
export function SideCard({
  label,
  title,
  note,
  children,
}: {
  label: string;
  title: ReactNode;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="border border-line bg-sheet text-note leading-[18px]">
      <h2 className="m-0 flex h-7.5 items-center justify-between gap-2 border-b border-line px-2.5 font-mono text-label leading-none font-semibold uppercase tracking-label whitespace-nowrap text-ink">
        <span className="flex min-w-0 items-center gap-2">{title}</span>
        {note && <span className="font-medium text-faint">{note}</span>}
      </h2>
      {children}
    </section>
  );
}
