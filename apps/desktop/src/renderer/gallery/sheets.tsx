import {
  DimensionLine,
  Drawing,
  Kbd,
  Led,
  SectionHeader,
  Sheet,
  SheetStrip,
  SheetStripCell,
  SheetStripStatus,
} from '@commander/ui';
import type { ReactNode } from 'react';

function SpecRow({ label, value, live }: { label: string; value: string; live?: boolean }) {
  return (
    <div
      className={`flex justify-between gap-2 border-b border-line2 py-[7px] font-mono text-label leading-[1.2] uppercase tracking-tag ${live ? 'text-signal-ink' : ''}`}
    >
      <dt className={live ? '' : 'text-muted'}>{label}</dt>
      <dd className={`m-0 font-semibold tabular-nums ${live ? '' : 'text-ink'}`}>{value}</dd>
    </div>
  );
}

function Key({ keys, children, ares }: { keys: ReactNode; children: ReactNode; ares?: boolean }) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-2 border-b border-line2 px-2.5 py-[5px] last:border-b-0">
      <span className="flex gap-1">{keys}</span>
      <span className={ares ? 'text-text' : ''}>{children}</span>
    </div>
  );
}

/** A Daily Note laid on the drawing, as in the reference build (round-3/industrial.html). */
export function DrawingSpecimen() {
  return (
    <Drawing active={{ column: 1, row: 8 }} className="h-[600px] overflow-hidden">
      <div className="pt-[18px]">
        <div className="mb-[13px] grid h-[13px] grid-cols-8">
          <DimensionLine className="col-start-1 mr-3 ml-3.5">A · Spec · 140</DimensionLine>
          <DimensionLine className="col-span-5 col-start-2">B–F · Daily Note · 700</DimensionLine>
          <DimensionLine className="col-span-2 col-start-7 mr-4 ml-3.5">G–H · Margin · 280</DimensionLine>
        </div>
        <div className="grid grid-cols-8">
          <aside className="col-start-1 mr-3 ml-3.5 font-mono">
            <div className="flex items-center justify-between gap-1.5 border-b-2 border-ink pb-2 text-kbd leading-none font-semibold tracking-heading whitespace-nowrap text-ink">
              <span>DN-274</span>
              <span className="inline-flex items-center gap-[5px] text-label tracking-caps text-signal-ink uppercase">
                <Led size="sm" />
                Live
              </span>
            </div>
            <div
              className="mt-4 mb-2.5 font-sans text-[64px] leading-[0.8] font-extrabold tracking-[-0.04em] text-transparent tabular-nums font-stretch-(--stretch-widest)"
              style={{ WebkitTextStroke: '1.25px var(--ink)' }}
            >
              01
            </div>
            <div className="border-b border-line pb-3 text-label-lg leading-none font-medium uppercase tracking-caps text-muted">
              Oct 2026 · Thu
            </div>
            <dl className="m-0">
              <SpecRow label="Meetings" value="03" />
              <SpecRow label="Open Todos" value="03" />
              <SpecRow label="Blocks" value="021" />
              <SpecRow label="From Ares" value="02" live />
            </dl>
          </aside>
          <Sheet className="col-span-5 col-start-2 bg-[linear-gradient(var(--line2),var(--line2))] bg-size-[1px_100%] bg-position-[36px_0] bg-no-repeat">
            <SheetStrip eyebrow="Today" live partNumber="DN-2026-274" sheet={[1, 3]} />
            <SectionHeader as="h2" size="day" title="Thursday" subtitle="1 October 2026" />
            <div className="relative flex min-h-8 items-center pt-1.5 pl-10">
              <span className="absolute left-0 w-[30px] text-right font-mono text-label leading-8 text-muted tabular-nums">
                001
              </span>
              <span className="grid h-8 w-6 place-items-center">
                <i className="block size-[7px] bg-ink" />
              </span>
              <span className="text-heading leading-7 font-bold uppercase tracking-[0.06em] text-ink font-stretch-[118%]">
                Morning
              </span>
            </div>
            <div className="relative flex items-start pr-7 pb-8 pl-16">
              <span className="absolute left-0 w-[30px] pt-0.5 text-right font-mono text-label leading-[30px] text-faint tabular-nums">
                002
              </span>
              <span className="-ml-6 grid h-[30px] w-6 shrink-0 place-items-center">
                <i className="block size-[5px] bg-faint" />
              </span>
              <span className="py-0.5 leading-[26px]">
                Slept badly but the head is clear. Big rocks today: get the Commander map moving and unblock
                Priya.
              </span>
            </div>
          </Sheet>
          <div className="col-span-2 col-start-7 mr-4 ml-3.5">
            <div className="border border-line bg-sheet text-small leading-[18px] text-muted">
              <div className="flex h-7.5 items-center justify-between border-b border-line px-2.5 font-mono text-label leading-none font-semibold uppercase tracking-label whitespace-nowrap text-ink">
                <span>Key · every line is a block</span>
                <span className="font-medium text-faint">LGD-01</span>
              </div>
              <Key keys={<Kbd>↵</Kbd>}>new block</Key>
              <Key keys={<Kbd>[[</Kbd>}>link a note</Key>
              <Key keys={<Kbd tone="signal">U</Kbd>} ares>
                ask Ares for an update
              </Key>
            </div>
          </div>
        </div>
      </div>
    </Drawing>
  );
}

/** The Dashboard's sheet head, as in the reference build (variants/feed.html). */
export function SectionHeaderSpecimen() {
  return (
    <div className="bg-bg px-3.5 pt-3.5 pb-5">
      <Sheet margin>
        <SectionHeader
          size="dashboard"
          eyebrow="Dashboard"
          partNumber="DSH-2026-274"
          status={<SheetStripStatus>Ranked by Ares · 11:38</SheetStripStatus>}
          meta={<SheetStripCell>6 Sections merged</SheetStripCell>}
          sheet={[1, 7]}
          title="What needs you"
          subtitle={
            <>
              Thursday 1 October 2026 · <b>24 items</b>, 4 of them before 13:00
            </>
          }
          aside={
            <div className="grid grid-cols-[auto_auto] gap-x-3.5 gap-y-[5px] pb-0.5 font-mono text-label leading-[19px] font-medium uppercase tracking-label whitespace-nowrap text-muted [&_kbd]:h-[17px] [&_kbd]:min-w-[17px] [&_kbd]:text-label">
              <span className="flex items-center gap-[7px]">
                <Kbd>J</Kbd>
                <Kbd>K</Kbd> Move
              </span>
              <span className="flex items-center gap-[7px]">
                <Kbd>↵</Kbd> Open
              </span>
              <span className="flex items-center gap-[7px]">
                <Kbd>X</Kbd> Tick
              </span>
              <span className="flex items-center gap-[7px]">
                <Kbd>E</Kbd> Clear
              </span>
              <span className="flex items-center gap-[7px]">
                <Kbd>B</Kbd> Badge
              </span>
              <span className="flex items-center gap-[7px]">
                <Kbd tone="signal">U</Kbd> Update
              </span>
            </div>
          }
        />
        <div className="relative flex h-[34px] items-center gap-3 border-b border-line bg-sheet pr-5 pl-13">
          <span className="absolute left-0 w-10 text-center font-mono text-label leading-none font-semibold tracking-code text-muted">
            B1
          </span>
          <span className="bg-ink px-2 pt-[5px] pb-1 text-[12.5px] leading-none font-extrabold uppercase tracking-heading text-sheet font-stretch-(--stretch-wider)">
            Now
          </span>
          <span className="flex items-center gap-2 text-note text-muted">
            <Led size="sm" />
            Before your 1:1 at 13:00 · 1h 20m left
          </span>
          <span className="ml-auto font-mono text-label-lg leading-none font-semibold uppercase tracking-label text-ink">
            04 <span className="font-medium text-faint">Open</span>
          </span>
        </div>
        <div className="hatch border-b border-line2 py-3 pr-5 pl-13 text-heading text-faint">
          Nothing waiting on others.
        </div>
      </Sheet>
    </div>
  );
}

/** Section headers at the Section size, with and without a live eyebrow. */
export function SectionHeaderSizes() {
  return (
    <div className="bg-bg px-3.5 pt-3.5 pb-5">
      <Sheet>
        <SectionHeader
          as="h2"
          eyebrow="Todos"
          partNumber="TDO-2026-274"
          sheet={[3, 7]}
          title="Todos"
          subtitle={
            <>
              <b>9 open</b> · 2 suggested by Ares
            </>
          }
        />
      </Sheet>
    </div>
  );
}
