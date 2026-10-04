import { Button, Input, toast } from '@commander/ui';
import { useEffect, useId, useState } from 'react';
import { SettingRow } from '../../settings/parts';
import { clock } from './agenda';
import { type CalendarSettingsClient, useSecondTimeZone } from './calendar-settings';
import { isTimeZone, timeZones, zoneName } from './zones';

/**
 * Settings → Calendar → Second time zone (#127): any time zone this machine knows, typed or picked
 * from the list, shown beside the Day and Week grids and in the event detail. Saved on Enter (or on
 * leaving the field); None takes it away.
 */
export function SecondTimeZoneSetting({
  settings,
  now = Date.now,
}: {
  settings: CalendarSettingsClient;
  now?: () => number;
}) {
  const saved = useSecondTimeZone(settings);
  const [text, setText] = useState('');
  const list = useId();
  const [zones] = useState(timeZones);
  useEffect(() => setText(saved ?? ''), [saved]);

  const typed = text.trim();
  const invalid = typed !== '' && !isTimeZone(typed);
  const save = (zone: string | null) => {
    if (zone === saved) return;
    settings
      .saveSecondTimeZone(zone)
      .catch((error) => toast(error instanceof Error ? error.message : String(error)));
  };
  const commit = () => {
    if (!typed) return save(null);
    if (!invalid) save(typed);
  };

  return (
    <SettingRow
      label="Second time zone"
      description="Shown as a second column of hours in the Day and Week views, and beside each event’s time in its detail. Your own times follow this computer’s time zone."
    >
      <div className="flex max-w-[460px] items-center gap-2">
        <Input
          aria-label="Second time zone"
          data-testid="second-time-zone"
          list={list}
          placeholder="America/New_York"
          value={text}
          aria-invalid={invalid || undefined}
          onChange={(change) => setText(change.target.value)}
          onBlur={commit}
          onKeyDown={(key) => {
            if (key.key === 'Enter') {
              key.preventDefault();
              commit();
            }
          }}
        />
        <datalist id={list}>
          {zones.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        <Button disabled={!saved} onClick={() => save(null)}>
          None
        </Button>
      </div>
      <p className="m-0 mt-1.5 font-mono text-label leading-tight uppercase tracking-label text-muted">
        {invalid
          ? 'Not a time zone this computer knows'
          : saved
            ? `${zoneName(saved)} · ${clock(now(), saved)} there now`
            : 'None'}
      </p>
    </SettingRow>
  );
}
