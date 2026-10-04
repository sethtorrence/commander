import type { CalendarSettings as Settings } from '@commander/domain';
import { Switch, toast } from '@commander/ui';
import { useEffect, useMemo, useState } from 'react';
import type { ItemStoreClient } from '../item-store/client';
import { calendarSettingsIn } from '../sections/calendar/calendar-settings';
import { SecondTimeZoneSetting } from '../sections/calendar/SecondTimeZoneSetting';
import { FocusTimeSettings } from './FocusTimeSettings';
import { SettingRow, SettingsGroup } from './parts';
import { SchedulingSettings } from './SchedulingSettings';

/**
 * Settings → Calendar (#128): the heads-up, a system notification 2 minutes before each meeting with
 * its title and time. The one interruption Commander makes (decision #23), so it is off until the
 * User turns it on here.
 */
export function CalendarSettings({
  no,
  itemStore = window.commander.itemStore,
}: {
  no: string;
  itemStore?: ItemStoreClient;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const calendar = useMemo(() => calendarSettingsIn(itemStore), [itemStore]);
  useEffect(() => {
    itemStore({ op: 'calendar-settings' }).then(setSettings, () => {});
  }, [itemStore]);
  const change = (headsUp: boolean) =>
    itemStore({ op: 'save-calendar-settings', settings: { headsUp } }).then(setSettings, (error) =>
      toast(error instanceof Error ? error.message : String(error)),
    );
  const on = settings?.headsUp ?? false;
  return (
    <SettingsGroup no={no} title="Calendar" note="Meetings · Focus time · Scheduling">
      <SettingRow
        label="Notify me 2 minutes before a meeting"
        description="A system notification with the meeting’s title and time, 2 minutes before each meeting that gets a chip in your Daily Note. Clicking it opens the event. It’s the only time Commander interrupts you, so it’s off until you turn it on, and it waits while your screen is locked."
      >
        <div className="flex items-center gap-3 font-mono text-label-lg leading-none font-semibold uppercase tracking-label text-ink">
          <Switch
            data-testid="meeting-heads-up"
            aria-label="Notify me 2 minutes before a meeting"
            checked={on}
            disabled={settings === null}
            onCheckedChange={(next) => void change(next)}
          />
          <span aria-hidden="true">{on ? 'On' : 'Off'}</span>
        </div>
      </SettingRow>
      <SecondTimeZoneSetting settings={calendar} />
      <FocusTimeSettings itemStore={itemStore} />
      <SchedulingSettings itemStore={itemStore} />
    </SettingsGroup>
  );
}
