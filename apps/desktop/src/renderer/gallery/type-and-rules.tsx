import { Caption } from './Plate';

const MONO_SIZES = [
  ['--text-micro', 'text-micro', '8'],
  ['--text-tiny', 'text-tiny', '8.5'],
  ['--text-label', 'text-label', '9'],
  ['--text-label-lg', 'text-label-lg', '9.5'],
  ['--text-kbd', 'text-kbd', '10'],
  ['--text-code', 'text-code', '11'],
  ['--text-code-lg', 'text-code-lg', '11.5'],
] as const;

export function TypeSpecimen() {
  return (
    <div className="flex flex-col">
      <div className="border-b border-line2 px-3.5 pt-4 pb-3">
        <div className="font-sans text-display leading-[0.9] font-extrabold uppercase tracking-display text-ink font-stretch-(--stretch-widest)">
          Thursday
        </div>
        <div className="mt-2.5 font-sans text-subtitle leading-[1.15] font-light tracking-[-0.01em] text-muted">
          1 October 2026
        </div>
        <Caption className="mt-2 block">Archivo 800 · 64 · width 125% / Archivo 300 · 26</Caption>
      </div>
      <div className="border-b border-line2 px-3.5 py-3">
        <div className="font-sans text-display-sm leading-display font-extrabold uppercase tracking-display text-ink font-stretch-(--stretch-widest)">
          What needs you
        </div>
        <div className="mt-2.5 font-sans text-lead leading-tight font-light text-muted">
          Thursday 1 October 2026 · <b className="font-medium text-text">24 items</b>
        </div>
        <Caption className="mt-2 block">Archivo 800 · 46 / Archivo 300 · 19</Caption>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-2 border-b border-line2 px-3.5 py-3">
        <span className="text-[12.5px] leading-none font-extrabold uppercase tracking-heading text-ink font-stretch-(--stretch-wider)">
          Now · band header
        </span>
        <Caption>800 · 12.5 · 118%</Caption>
        <span className="text-row leading-[22px] font-semibold tracking-[-0.006em] text-ink">
          Give Priya Acme sandbox access
        </span>
        <Caption>600 · 15 · row</Caption>
        <span className="text-body text-text">Slept badly but the head is clear. Big rocks today.</span>
        <Caption>400 · 15.5 · body</Caption>
        <span className="text-note leading-[19px] text-muted">
          You wrote it down in your 1:1. Nobody has done it yet.
        </span>
        <Caption>400 · 13 · why</Caption>
      </div>
      <div className="flex items-end gap-6 border-b border-line2 px-3.5 py-3">
        <span className="font-sans text-count leading-[0.9] font-extrabold tracking-[-0.03em] text-signal-ink tabular-nums font-stretch-(--stretch-widest)">
          04
        </span>
        <span className="font-sans text-figure leading-none font-bold tracking-[-0.01em] text-ink tabular-nums font-stretch-(--stretch-wide)">
          13
        </span>
        <Caption>Figures · Archivo 800 · 33 / 700 · 21</Caption>
      </div>
      <div className="flex flex-col gap-2 px-3.5 py-3">
        {MONO_SIZES.map(([token, cls, px]) => (
          <div key={token} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-4">
            <span className={`font-mono ${cls} leading-none font-semibold uppercase tracking-label text-ink`}>
              DN-2026-274 · Sheet 01 / 03
            </span>
            <Caption>
              Plex Mono · {px} · {token}
            </Caption>
          </div>
        ))}
      </div>
    </div>
  );
}

const METRICS = [
  ['--rul', 'Ruler'],
  ['--hdr', 'Header'],
  ['--top', 'Drawing top'],
  ['--tabs', 'Notebook tabs'],
  ['--body', 'Sheet top'],
  ['--strip', 'Title strip'],
  ['--sheet-margin', 'Numbered margin'],
  ['--sheet-gutter', 'Row indent'],
] as const;

export function RulesSpecimen() {
  return (
    <div className="grid grid-cols-2">
      <div className="flex flex-col gap-3.5 border-r border-line2 px-3.5 py-3.5">
        {[
          ['h-px bg-line', 'Rule · 1px --line'],
          ['h-px bg-line2', 'Rule, faint · 1px --line2'],
          ['h-0.5 bg-ink', 'Heavy rule · 2px ink'],
          ['h-[3px] bg-signal', 'Live edge · 3px signal'],
        ].map(([cls, label]) => (
          <div key={label} className="flex flex-col gap-1.5">
            <span className={cls} />
            <Caption>{label}</Caption>
          </div>
        ))}
        <div className="flex gap-2.5">
          <span className="hatch h-10 flex-1 border border-dashed border-line" />
          <span className="h-10 flex-1 border border-line bg-raise" />
        </div>
        <Caption>Hatching (empty, past) · raised</Caption>
      </div>
      <div className="flex flex-col gap-1.5 px-3.5 py-3.5">
        {METRICS.map(([token, label]) => (
          <div key={token} className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-2.5">
            <Caption>{label}</Caption>
            <span className="flex items-center gap-2">
              <span className="h-2.5 border border-muted bg-hatch" style={{ width: `var(${token})` }} />
              <span className="font-mono text-tiny tracking-code text-faint">{token}</span>
            </span>
          </div>
        ))}
        <Caption className="mt-2">No radii · no soft shadows · 4px spacing step</Caption>
      </div>
    </div>
  );
}
