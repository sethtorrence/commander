import type { WindowControl, WindowFrame } from '@commander/domain';
import { type ReactNode, useEffect, useState } from 'react';
import type { CommanderBridge } from '../../preload';

export type WindowBridge = Pick<CommanderBridge, 'windowFrame' | 'windowControl' | 'onWindowFrame'>;

/** How the window's frame behaves here, kept current as it is maximised and restored. */
export function useWindowFrame(bridge: WindowBridge = window.commander): WindowFrame | null {
  const [frame, setFrame] = useState<WindowFrame | null>(null);
  useEffect(() => {
    let pushed = false;
    let live = true;
    const stop = bridge.onWindowFrame((next) => {
      pushed = true;
      setFrame(next);
    });
    bridge.windowFrame().then(
      (first) => {
        if (live && !pushed) setFrame(first);
      },
      () => {},
    );
    return () => {
      live = false;
      stop();
    };
  }, [bridge]);
  return frame;
}

// Glyphs drawn like the prototypes' (.tbx svg): 1.5px strokes, square caps, mitred corners.
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.5}>
      {children}
    </svg>
  );
}
const MINIMISE = <path d="M2 9.25h8" strokeLinecap="square" />;
const MAXIMISE = <rect x="2.25" y="2.25" width="7.5" height="7.5" />;
const RESTORE = (
  <>
    <rect x="1.75" y="4.25" width="6" height="6" />
    <path d="M4.25 4.25v-2h6v6h-2.5" />
  </>
);
const CLOSE = <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" strokeLinecap="square" />;

/**
 * Minimise, maximise or restore, and close, at the header's right edge (the window has no other
 * frame). Close hides Commander to the tray, as closing the window always has; Quit is in the tray.
 */
export function WindowControls({
  frame,
  onControl,
}: {
  frame: WindowFrame | null;
  onControl: (control: WindowControl) => void;
}) {
  if (frame?.controls !== 'header') return null;
  const restore = frame.maximised;
  const controls = [
    {
      control: 'minimise',
      label: 'Minimise',
      short: 'Min',
      title: frame.minimise === 'hide' ? 'Minimise · Commander waits in the tray' : 'Minimise',
      glyph: MINIMISE,
    },
    {
      control: 'toggle-maximise',
      label: restore ? 'Restore' : 'Maximise',
      short: restore ? 'Rst' : 'Max',
      title: restore ? 'Restore' : 'Maximise',
      glyph: restore ? RESTORE : MAXIMISE,
    },
    {
      control: 'close',
      label: 'Close',
      short: 'Close',
      title: 'Close · Commander keeps running in the tray (Quit is in the tray menu)',
      glyph: CLOSE,
    },
  ] as const;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and form semantics
    <div className="f-win" role="group" aria-label="Window" data-testid="window-controls">
      {controls.map(({ control, label, short, title, glyph }) => (
        <button
          key={control}
          type="button"
          className="f-wc"
          data-control={control}
          aria-label={label}
          title={title}
          onClick={() => onControl(control)}
        >
          <Glyph>{glyph}</Glyph>
          <span className="l" aria-hidden="true">
            {short}
          </span>
        </button>
      ))}
    </div>
  );
}
