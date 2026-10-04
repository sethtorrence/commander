import type { CalendarSettings } from '@commander/domain';
import { useEffect, useState } from 'react';
import type { ItemStoreClient } from '../../item-store/client';

/*
  Settings → Calendar as the Calendar Section reads it (#127): the second time zone, kept in the Item
  store so it survives restarts. Settings saves it through here, and the Section hears the change at
  once (both are in the same window).
*/

const CHANGED = 'commander:calendar-settings';

export interface CalendarSettingsClient {
  read(): Promise<CalendarSettings>;
  /** Saves the second time zone (null: none), leaving the other settings as they are. */
  saveSecondTimeZone(zone: string | null): Promise<CalendarSettings>;
  /** Called with the settings whenever they are saved. Returns the unsubscribe. */
  onChange(listener: (settings: CalendarSettings) => void): () => void;
}

export function calendarSettingsIn(
  itemStore: ItemStoreClient,
  target: EventTarget = window,
): CalendarSettingsClient {
  return {
    read: () => itemStore({ op: 'calendar-settings' }),
    async saveSecondTimeZone(zone) {
      const { headsUp } = await itemStore({ op: 'calendar-settings' });
      const saved = await itemStore({
        op: 'save-calendar-settings',
        settings: { headsUp, secondTimeZone: zone },
      });
      target.dispatchEvent(new CustomEvent(CHANGED, { detail: saved }));
      return saved;
    },
    onChange(listener) {
      const heard = (event: Event) => listener((event as CustomEvent<CalendarSettings>).detail);
      target.addEventListener(CHANGED, heard);
      return () => target.removeEventListener(CHANGED, heard);
    },
  };
}

/** The second time zone, kept current: null while there is none (or before it is read). */
export function useSecondTimeZone(client: CalendarSettingsClient | undefined): string | null {
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => {
    if (!client) return;
    let current = true;
    client.read().then(
      (settings) => current && setZone(settings.secondTimeZone ?? null),
      () => {},
    );
    const stop = client.onChange((settings) => setZone(settings.secondTimeZone ?? null));
    return () => {
      current = false;
      stop();
    };
  }, [client]);
  return zone;
}
