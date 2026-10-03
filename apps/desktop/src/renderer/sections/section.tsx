import { cn, SectionHeader, type SectionHeaderProps, Sheet } from '@commander/ui';
import { type ComponentType, createContext, type ReactNode, useContext, useMemo } from 'react';
import { partNumber } from '../frame/calendar';
import { useNow } from '../frame/use-now';

/*
  What a Section is to the frame. Each Section lives in its own folder (sections/<id>/) and exports
  one SectionDefinition; sections/index.ts lists them in tab order, which also gives them their
  number key. The frame keeps every Section mounted (hidden when another is open), wraps it in a
  shortcut scope named after its id, and passes nothing else: inside, `useSection()` says where it
  sits, `useShortcuts()` adds keys that work only while it is open, and <SectionSheet> draws its
  sheet with the title strip and part number.
*/
export interface SectionDefinition {
  /** Stable id, also the shortcut scope: "todos". */
  id: string;
  /** The tab label and the sheet's eyebrow: "Todos". */
  label: string;
  /** The header's title when it differs from the label ("Daily Notes"). */
  headerTitle?: string;
  /** The part-number code on its sheets: "TDO" gives TDO-2026-274. */
  code: string;
  Component: ComponentType;
}

export interface SectionPlace {
  definition: SectionDefinition;
  /** Its tab number and key, from 1. */
  number: number;
  /** How many Sections there are (the "Sheet 03 / 08" count). */
  total: number;
  /** Whether it is the open Section. */
  active: boolean;
}

const SectionContext = createContext<SectionPlace | null>(null);

export function SectionProvider({ place, children }: { place: SectionPlace; children: ReactNode }) {
  return <SectionContext.Provider value={place}>{children}</SectionContext.Provider>;
}

/** Where the calling Section sits in the frame. */
export function useSection(): SectionPlace & { partNumber: string } {
  const place = useContext(SectionContext);
  if (!place) throw new Error('useSection must be called inside a Section');
  const today = useNow(60_000);
  const part = partNumber(place.definition.code, today);
  return useMemo(() => ({ ...place, partNumber: part }), [place, part]);
}

/**
 * A Section's sheet: the title strip (eyebrow, part number, sheet number) and big title, then the
 * Section's own content. `span` follows the prototype's layouts on the eight-column grid: `full`
 * (A–H) or `wide` (A–F, leaving G–H for a side column).
 */
export function SectionSheet({
  span = 'full',
  title,
  size,
  children,
  className,
  ...header
}: Omit<SectionHeaderProps, 'title' | 'eyebrow' | 'partNumber' | 'sheet' | 'children'> & {
  span?: 'full' | 'wide';
  title?: ReactNode;
  children?: ReactNode;
}) {
  const { definition, number, total, partNumber: part } = useSection();
  return (
    <Sheet
      data-testid={`section-${definition.id}`}
      className={cn(
        'min-h-[calc(100vh-var(--body))] border-t-0',
        span === 'full' ? 'col-span-8 mr-4 ml-3.5' : 'col-span-6 ml-3.5',
        className,
      )}
    >
      <SectionHeader
        eyebrow={definition.label}
        partNumber={part}
        sheet={[number, total]}
        title={title ?? definition.label}
        size={size}
        {...header}
      />
      {children}
    </Sheet>
  );
}

/** The empty sheet a Section shows until its own ticket fills it in. */
export function EmptySheet({ children }: { children: ReactNode }) {
  return (
    <p className="hatch m-0 border-b border-line2 py-3 pr-5 pl-13 text-heading text-faint">{children}</p>
  );
}
