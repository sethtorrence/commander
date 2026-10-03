import {
  Badge,
  contrastRatio,
  PROJECT_ACCENTS,
  ProjectFilterBar,
  SHEET_COLOUR,
  type Theme,
  useAppearance,
} from '@commander/ui';
import { useEffect, useRef, useState } from 'react';
import { Caption } from './Plate';

const COLOURS = [
  ['--bg', 'Desk'],
  ['--sheet', 'Sheet'],
  ['--raise', 'Raised'],
  ['--ink', 'Ink'],
  ['--text', 'Text'],
  ['--muted', 'Muted'],
  ['--faint', 'Faint'],
  ['--line', 'Rule'],
  ['--line2', 'Rule, faint'],
  ['--grid', 'Grid column'],
  ['--grid2', 'Grid row'],
  ['--cross', 'Grid cross'],
  ['--hatch', 'Hatching'],
] as const;

const SIGNALS = [
  ['--signal', 'Signal fill / lines'],
  ['--on-signal', 'Text on signal'],
  ['--signal-ink', 'Signal text'],
  ['--signal-soft', 'Signal wash'],
  ['--signal-focus', 'Focused row'],
  ['--signal-sel', 'Selection'],
] as const;

/** Reads a custom property's live value in this element's theme. */
function useTokenValue(name: string) {
  const ref = useRef<HTMLSpanElement>(null);
  const [value, setValue] = useState('');
  const { signal, theme } = useAppearance();
  // A passive effect runs after the AppearanceProvider has written the new signal values.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the signal colour or theme changes.
  useEffect(() => {
    if (ref.current) setValue(getComputedStyle(ref.current).getPropertyValue(name).trim());
  }, [name, signal.hex, theme]);
  return { ref, value };
}

function Swatch({ name, label }: { name: string; label: string }) {
  const { ref, value } = useTokenValue(name);
  return (
    <div className="grid grid-cols-[36px_minmax(0,1fr)] items-center gap-2.5 border-b border-line2 py-1.5 pr-3.5 pl-3.5">
      <span
        ref={ref}
        className="h-6 border border-line2 bg-sheet"
        style={{ backgroundImage: `linear-gradient(var(${name}), var(${name}))` }}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-small leading-4 text-ink">{label}</span>
        <span className="truncate font-mono text-tiny leading-3 tracking-code text-muted">
          {name} · <span data-token={name}>{value.toUpperCase()}</span>
        </span>
      </span>
    </div>
  );
}

export function ColourTokens() {
  return (
    <div className="grid grid-cols-2">
      <div className="border-r border-line2">
        {COLOURS.map(([name, label]) => (
          <Swatch key={name} name={name} label={label} />
        ))}
      </div>
      <div>
        {SIGNALS.map(([name, label]) => (
          <Swatch key={name} name={name} label={label} />
        ))}
        <p className="m-0 px-3.5 py-3 text-note leading-[19px] text-muted">
          One picked colour, derived per theme: lines nudged to 3:1 on the sheet, coloured text to 4.5:1. Used
          only on live things and on Ares.
        </p>
      </div>
    </div>
  );
}

const SAMPLE_CODES: Record<string, [string, string]> = {
  blue: ['LT', 'Longtail'],
  teal: ['TL', 'Titanlink'],
  violet: ['TX', 'Tactics'],
  magenta: ['MG', 'Magenta'],
  green: ['GR', 'Green'],
  sky: ['SK', 'Sky'],
  lime: ['LM', 'Lime'],
  slate: ['SL', 'Slate'],
};

export function AccentTokens({ theme }: { theme: Theme }) {
  return (
    <div>
      <div className="grid grid-cols-4">
        {PROJECT_ACCENTS.map((accent) => {
          const [code, project] = SAMPLE_CODES[accent.name] ?? ['??', accent.name];
          const value = accent[theme];
          return (
            <div
              key={accent.name}
              className="relative flex flex-col gap-1.5 border-r border-b border-line2 py-2.5 pr-2.5 pl-4 [&:nth-child(4n)]:border-r-0"
            >
              <span className="absolute top-0 bottom-0 left-0 w-0.5" style={{ background: value }} />
              <span className="flex items-center gap-2">
                <Badge code={code} project={project} accent={accent.name} />
                <span className="text-small text-ink capitalize">{accent.name}</span>
              </span>
              <Caption>
                {value} · {contrastRatio(value, SHEET_COLOUR[theme]).toFixed(1)}:1
              </Caption>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-3.5 py-3.5">
        <span className="flex items-center gap-2">
          <Badge kind="unfiled" />
          <Caption>Unfiled</Caption>
        </span>
        <span className="flex items-center gap-2">
          <Badge code="TL" project="Titanlink" accent="teal" kind="suggested" />
          <Caption>Suggested by Ares</Caption>
        </span>
        <span className="flex items-center gap-2">
          <Badge code="LT" project="Longtail" accent="blue" size="sm" />
          <Badge code="LT" project="Longtail" accent="blue" />
          <Badge code="LT" project="Longtail" accent="blue" size="lg" />
          <Caption>sm · default · lg</Caption>
        </span>
      </div>
      <div className="overflow-x-auto border-t border-line2">
        <ProjectFilterBar
          className="w-max min-w-full border-b-0"
          projects={[
            { id: 'lt', code: 'LT', name: 'Longtail', accent: 'blue', count: 3 },
            { id: 'tl', code: 'TL', name: 'Titanlink', accent: 'teal', count: 5 },
            { id: 'tx', code: 'TX', name: 'Tactics', accent: 'violet', count: 0 },
          ]}
          everything={9}
          unfiled={1}
          selected="lt"
          onSelect={() => {}}
        />
      </div>
    </div>
  );
}
