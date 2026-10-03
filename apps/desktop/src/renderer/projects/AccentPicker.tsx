import { accentFor, checkAccent, cn, Input, PROJECT_ACCENTS, THEMES } from '@commander/ui';
import { useEffect, useId, useState } from 'react';

const THEME_NAMES = { dark: 'Dark', light: 'Light' } as const;
const label =
  'mb-1.5 block font-mono text-label leading-none font-semibold uppercase tracking-label text-muted';

/** A typed hex colour as `#RRGGBB`, or null while it isn't one. */
function hexOf(text: string): string | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(text.trim());
  return match ? `#${match[1]?.toUpperCase()}` : null;
}

/**
 * A Project's accent: one of the palette of 8, or any colour from the picker. A custom colour is
 * checked like the signal colour: per theme it is deepened until it reaches 3:1 on the sheet (the
 * readout shows what each theme will use), and a colour close to international orange gets a warning,
 * as orange is kept for live things and Ares. `used` dims the accents other Projects already have;
 * accents may repeat.
 */
export function AccentPicker({
  value,
  onChange,
  used = new Set(),
}: {
  value: string;
  onChange: (accent: string) => void;
  used?: ReadonlySet<string>;
}) {
  const ids = { accents: useId(), hex: useId(), group: useId() };
  const custom = accentFor(value) ? null : hexOf(value);
  const [draft, setDraft] = useState(custom ?? '');
  useEffect(() => {
    if (custom) setDraft(custom);
  }, [custom]);
  const check = custom ? checkAccent(custom) : null;

  return (
    <div className="flex flex-col gap-2.5">
      <span id={ids.accents} className={cn(label, 'mb-0')}>
        Accent · <span className="text-ink">{custom ? 'Custom' : value}</span>
      </span>
      <div role="radiogroup" aria-labelledby={ids.accents} className="flex flex-wrap items-center gap-2">
        {PROJECT_ACCENTS.map((option) => (
          <input
            key={option.name}
            type="radio"
            name={ids.group}
            checked={option.name === value}
            onChange={() => onChange(option.name)}
            aria-label={`${option.name}${used.has(option.name) ? ' (in use)' : ''}`}
            title={`${option.name}${used.has(option.name) ? ' · in use' : ''}`}
            className={cn(
              'm-0 size-7.5 cursor-pointer appearance-none border border-line hover:border-ink checked:outline-2 checked:outline-offset-2 checked:outline-ink checked:outline-solid',
              used.has(option.name) && 'opacity-45',
            )}
            style={{ background: `var(--accent-${option.name})` }}
          />
        ))}
        <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
        <input
          type="color"
          aria-label="Pick any accent colour"
          title="Any colour"
          value={(custom ?? '#3D7BFF').toLowerCase()}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className={cn(
            'h-7.5 w-9.5 cursor-pointer border border-line bg-transparent p-0',
            custom && 'outline-2 outline-offset-2 outline-ink outline-solid',
          )}
        />
        <label htmlFor={ids.hex} className="sr-only">
          Custom accent colour
        </label>
        <Input
          id={ids.hex}
          font="mono"
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          placeholder="#RRGGBB"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            const hex = hexOf(event.target.value);
            if (hex) onChange(hex);
          }}
          className="w-23"
        />
      </div>
      {check && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2.5">
            {THEMES.map((theme) => (
              <span
                key={theme}
                data-theme={theme}
                title={`${THEME_NAMES[theme]} theme: ${check[theme]}`}
                className="flex h-7 items-center gap-2 border border-line bg-sheet px-2.5 font-mono text-label leading-none font-semibold uppercase tracking-tag text-ink"
              >
                <span
                  className="inline-grid h-4 w-[25px] place-items-center font-bold"
                  style={{ background: check[theme], color: check.text[theme] }}
                  aria-hidden="true"
                >
                  AB
                </span>
                {THEME_NAMES[theme]} · {check.contrast[theme].toFixed(1)}:1
              </span>
            ))}
          </div>
          {check.adjusted && (
            <p className="m-0 text-note leading-[19px] text-muted">
              Deepened where it was below 3:1 on the sheet, so the Badge stays legible in both themes.
            </p>
          )}
          {check.nearOrange && (
            <p role="alert" className="m-0 text-note leading-[19px] font-semibold text-signal-ink">
              This is close to orange, which Commander keeps for live things and Ares. Pick another colour if
              you can.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
