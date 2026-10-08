import { AresMark, cn, Kbd, Led } from '@commander/ui';
import type { Ref } from 'react';
import { clockTime, dayOfYear, isoWeek, shortDate } from './calendar';
import { useNow } from './use-now';
import { useWindowFrame, WindowControls } from './WindowControls';

const pad = (n: number) => String(n).padStart(2, '0');

// The Dashboard's bands. Counts arrive with the Dashboard; until then every band reads zero.
const BANDS = [
  { id: 'now', label: 'Now' },
  { id: 'today', label: 'Today' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'fyi', label: 'FYI' },
] as const;
export type BandCounts = Partial<Record<(typeof BANDS)[number]['id'], number>>;

export interface AresStatusProps {
  /** How many things Ares is holding for the next Update. */
  queued?: number;
  /** Whether the User is at the machine, as Ares sees it. */
  presence?: 'here' | 'away';
  /** When the User went away. */
  awaySince?: Date;
  /** Whether one of Ares's jobs is running, and which. */
  working?: AresWork;
  /** Opens Ares's activity page. */
  onOpen?: () => void;
  /** Runs the Update Skill: Ask for an update (`U`). */
  onAsk?: () => void;
  /** The Ares panel (#235): whether it is open, and its AI mark, which opens or closes it (`Ctrl+J`). */
  panel?: { open: boolean; onToggle: () => void };
}

export type AresWork = { working: boolean; running: readonly string[] };

const things = (n: number) => `${n} thing${n === 1 ? '' : 's'}`;
const hhmm = (date: Date) => clockTime(date).slice(0, 5);

/**
 * The Ares status module (.ttn): whether he is working or idle, the quiet count of what he is
 * holding for the next Update, whether you're here, the Ares panel's AI mark, and Ask for an update.
 */
export function AresStatus({
  queued = 0,
  presence = 'here',
  awaySince,
  working,
  onOpen,
  onAsk,
  panel,
}: AresStatusProps) {
  const away = presence === 'away';
  const busy = !!working?.working;
  const line = busy
    ? `Ares is working on ${working?.running.join(', ') || 'something'}`
    : !queued
      ? 'Ares has nothing for you right now'
      : away
        ? `Ares is holding ${things(queued)} for you`
        : `Ares has ${things(queued)} for you`;
  return (
    <section
      className={cn('f-ares', !queued && 'empty')}
      aria-label="Ares"
      data-testid="ares-status"
      data-working={busy || undefined}
    >
      {/* Covers the count and the lines: the whole module opens Ares's activity page. */}
      <button type="button" className="f-ares-open" onClick={onOpen} aria-label="Ares’s activity" />
      <div className="f-ares-count" title="Things Ares is holding for you">
        <b data-testid="ares-queued">{pad(queued)}</b>
        <span>Queued</span>
      </div>
      <div className="f-ares-info">
        <div className="f-ares-l1">
          <span>Ares</span>
          <span className={cn('state', busy && 'busy')} data-testid="ares-state" aria-live="polite">
            {busy ? 'Working' : 'Idle'}
          </span>
          <span className="pres" data-testid="ares-presence">
            <Led size="sm" state={away ? 'off' : 'on'} />
            {away ? `Away${awaySince ? ` · since ${hhmm(awaySince)}` : ''}` : 'You’re here'}
          </span>
        </div>
        <div className="f-ares-l2">{line}</div>
      </div>
      {panel && (
        <button
          type="button"
          className="f-talk"
          onClick={panel.onToggle}
          aria-label="Ares panel"
          aria-pressed={panel.open}
          aria-keyshortcuts="Control+J"
          title={`${panel.open ? 'Close' : 'Open'} the Ares panel: Conversations beside this Section (Ctrl+J)`}
        >
          <AresMark />
          <span className="l">Ctrl J</span>
        </button>
      )}
      <button
        type="button"
        className="f-ask"
        onClick={onAsk}
        aria-label="Ask for an update"
        title="Ask Ares for an update (U)"
      >
        <span>
          Ask for
          <br />
          an update
        </span>
        <Kbd>U</Kbd>
      </button>
    </section>
  );
}

export interface HeaderProps {
  /** The small line above the title: "Sec 03 / Todos". */
  eyebrow: string;
  title: string;
  bands?: BandCounts;
  onBand?: (band: string) => void;
  ares?: AresStatusProps;
  /** The Ares panel's open state and toggle, for its AI mark in the Ares module. */
  panel?: AresStatusProps['panel'];
  /**
   * Where the open Section can put its own strip across C–E (the Notes Section's week strip). While
   * something is in it, it takes the place of the date and the band meter.
   */
  slotRef?: Ref<HTMLDivElement>;
}

/**
 * The Industrial header (.hdr): identity and clock, the date, the band meter, and Ares. It is also
 * the window's title bar: drag it to move the window, and its right edge holds the window controls.
 */
export function Header({ eyebrow, title, bands = {}, onBand, ares, panel, slotRef }: HeaderProps) {
  const now = useNow(1000);
  const frame = useWindowFrame();
  return (
    <header className="f-hdr" data-window-controls={frame?.controls}>
      <div className="f-corner" aria-hidden="true" />
      <div className="f-id">
        <span className="f-mark" title="Commander">
          C
        </span>
        <div className="f-idt">
          <div className="f-sec" data-testid="header-eyebrow">
            {eyebrow}
          </div>
          <div className="f-title" data-testid="header-title">
            {title}
          </div>
          <div className="f-clock">
            <Led size="sm" />
            <time dateTime={now.toISOString()}>{clockTime(now)}</time>
            <small>Local</small>
          </div>
        </div>
      </div>
      <div className="f-wk">
        <div className="f-wkn">{shortDate(now)}</div>
        <div className="f-wkr">
          Week {isoWeek(now)} · D {dayOfYear(now)}
          <br />
          {now.getFullYear()}
        </div>
      </div>
      <nav className="f-meter" aria-label="What needs you, by band">
        {BANDS.map((band) => {
          const count = bands[band.id] ?? 0;
          return (
            <button
              key={band.id}
              type="button"
              className={cn('f-mc', !count && 'zero', band.id === 'now' && count > 0 && 'live')}
              onClick={() => onBand?.(band.id)}
              title={`${band.label} · on the Dashboard`}
            >
              <span className="w">{band.label}</span>
              <span className="n">{pad(count)}</span>
            </button>
          );
        })}
      </nav>
      <div className="f-slot" ref={slotRef} />
      <AresStatus {...ares} panel={panel} />
      <WindowControls frame={frame} onControl={(control) => void window.commander.windowControl(control)} />
    </header>
  );
}
