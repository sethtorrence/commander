import { useEffect, useId, useState } from 'react';
import { cn } from '../lib/cn';
import { DEFAULT_SIGNAL, SIGNAL_PRESETS, type SignalShades } from '../signal/signal';
import { useAppearance } from '../theme/appearance-provider';
import { THEMES, type Theme } from '../theme/themes';
import { Button } from './button';
import { Input } from './input';

const ratio = (value: number) => `${value.toFixed(1)}:1`;

function Readout({ theme, shades, picked }: { theme: Theme; shades: SignalShades; picked: string }) {
  const rows = [
    { label: 'Fill / lines', value: shades.fill, swatch: shades.fill, contrast: shades.fillContrast },
    {
      label: 'Text on fill',
      value: shades.onFill === '#FFFFFF' ? 'white' : 'black',
      swatch: shades.fill,
      ring: shades.onFill,
      contrast: shades.onFillContrast,
    },
    { label: 'Coloured text', value: shades.ink, swatch: shades.ink, contrast: shades.inkContrast },
  ];
  const name = theme === 'dark' ? 'Dark theme' : 'Light theme';
  return (
    <fieldset aria-label={name} className="m-0 min-w-0 border border-line p-0">
      <legend className="sr-only">{name}</legend>
      <div className="flex h-7 items-center justify-between gap-2 border-b border-line2 px-2.5 font-mono text-label font-semibold uppercase leading-none tracking-label text-ink">
        <span>{name}</span>
        {shades.adjusted && <span className="font-medium text-faint">Adjusted from {picked}</span>}
      </div>
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-line2 px-2.5 py-1.5 font-mono text-label uppercase leading-none tracking-tag text-muted last:border-b-0"
        >
          <span
            className="size-3"
            style={{
              background: row.swatch,
              outline: row.ring ? `3px solid ${row.ring}` : undefined,
              outlineOffset: row.ring ? '-5px' : undefined,
            }}
          />
          <span className="truncate">
            {row.label} <b className="font-semibold text-ink">{row.value}</b>
          </span>
          <span className="font-semibold text-ink tabular-nums">{ratio(row.contrast)}</span>
        </div>
      ))}
    </fieldset>
  );
}

/**
 * The signal colour setting: pick a preset or any colour. Every signal shade is derived per theme
 * and nudged until lines reach 3:1 and coloured text 4.5:1 on the sheet; the readout shows the result.
 */
export function SignalColourPicker({ className }: { className?: string }) {
  const { signal, setSignal, resetSignal } = useAppearance();
  const [draft, setDraft] = useState(signal.hex);
  const hexId = useId();
  const presetsName = useId();
  useEffect(() => setDraft(signal.hex), [signal.hex]);
  const preset = SIGNAL_PRESETS.find((p) => p.hex === signal.hex);

  return (
    <div data-slot="signal-colour-picker" className={cn('flex flex-col gap-3.5', className)}>
      <div className="font-mono text-label font-semibold uppercase leading-none tracking-label text-muted">
        Signal colour · <span className="text-ink">{preset?.name ?? 'Custom'}</span>
      </div>
      <div role="radiogroup" aria-label="Signal colour presets" className="flex flex-wrap gap-2">
        {SIGNAL_PRESETS.map((p) => (
          <input
            key={p.hex}
            type="radio"
            name={presetsName}
            checked={p.hex === signal.hex}
            onChange={() => setSignal(p.hex)}
            aria-label={p.name}
            title={`${p.name} · ${p.hex}`}
            className="m-0 size-7.5 cursor-pointer appearance-none border border-line hover:border-ink checked:outline-2 checked:outline-offset-2 checked:outline-ink checked:outline-solid"
            style={{ background: p.hex }}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="color"
          aria-label="Pick any colour"
          value={signal.hex.toLowerCase()}
          onChange={(e) => setSignal(e.target.value)}
          className="h-7.5 w-9.5 cursor-pointer border border-line bg-transparent p-0"
        />
        <label htmlFor={hexId} className="sr-only">
          Hex colour
        </label>
        <Input
          id={hexId}
          font="mono"
          maxLength={7}
          spellCheck={false}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setSignal(e.target.value);
          }}
          onBlur={() => setDraft(signal.hex)}
          className="w-23"
        />
        <Button variant="ghost" onClick={resetSignal} disabled={signal.hex === DEFAULT_SIGNAL}>
          Reset to orange
        </Button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2.5">
        {THEMES.map((theme) => (
          <Readout key={theme} theme={theme} shades={signal[theme]} picked={signal.hex} />
        ))}
      </div>
    </div>
  );
}
