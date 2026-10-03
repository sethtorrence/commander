import { cn, Kbd, Led } from '@commander/ui';
import { clockTime, dayOfYear, isoWeek, shortDate } from './calendar';
import { useNow } from './use-now';

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
}

const things = (n: number) => `${n} thing${n === 1 ? '' : 's'}`;
const hhmm = (date: Date) => clockTime(date).slice(0, 5);

/**
 * The Ares status module (.ttn): what he is holding, whether you're here, and Ask for an update.
 * A placeholder until Updates arrive: nothing is queued and the button does nothing yet.
 */
export function AresStatus({ queued = 0, presence = 'here', awaySince }: AresStatusProps) {
  const away = presence === 'away';
  const line = !queued
    ? 'Ares has nothing for you right now'
    : away
      ? `Ares is holding ${things(queued)} for you`
      : `Ares has ${things(queued)} for you`;
  return (
    <section className={cn('f-ares', !queued && 'empty')} aria-label="Ares" data-testid="ares-status">
      <div className="f-ares-count" title="Things Ares is holding for you">
        <b data-testid="ares-queued">{pad(queued)}</b>
        <span>Queued</span>
      </div>
      <div className="f-ares-info">
        <div className="f-ares-l1">
          <span>Ares</span>
          <span className="pres" data-testid="ares-presence">
            <Led size="sm" state={away ? 'off' : 'on'} />
            {away ? `Away${awaySince ? ` · since ${hhmm(awaySince)}` : ''}` : 'You’re here'}
          </span>
        </div>
        <div className="f-ares-l2">{line}</div>
      </div>
      <button
        type="button"
        className="f-ask"
        aria-disabled="true"
        title="Updates from Ares come in a later milestone"
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
}

/** The Industrial header (.hdr): identity and clock, the date, the band meter, and Ares. */
export function Header({ eyebrow, title, bands = {}, onBand, ares }: HeaderProps) {
  const now = useNow(1000);
  return (
    <header className="f-hdr">
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
      <AresStatus {...ares} />
    </header>
  );
}
