import type { CoreMessage } from '@commander/domain';

/*
  The meeting heads-up, main-process half (#128). The Core decides when (2 minutes before a meeting
  that gets a chip, only once the User has turned it on in Settings → Calendar, and not while the
  screen is locked) and sends `meeting-heads-up`; this shows it as a system notification with the
  meeting's title and time, and clicking it opens the event in the Calendar Section. It is the one
  exception to "Ares never interrupts" (decision #23), so it says nothing beyond the meeting itself.
*/

/** What this needs of Electron's Notification. */
export type HeadsUpNotification = {
  on(event: 'click', listener: () => void): void;
  show(): void;
};

export type ShownHeadsUp = { itemId: string; title: string; body: string };

export function createMeetingHeadsUp({
  notify,
  open,
}: {
  /** Makes a system notification, or null where the system has none. */
  notify(options: { title: string; body: string }): HeadsUpNotification | null;
  /** Shows the window with the event open in the Calendar Section. */
  open(itemId: string): void;
}) {
  const shown: ShownHeadsUp[] = [];
  return {
    /** A message from the Core. True when it was a heads-up, handled here. */
    handle(message: CoreMessage): boolean {
      if (message.type !== 'meeting-heads-up') return false;
      const { itemId, title, times } = message;
      const body = `${times} · starts in 2 minutes`;
      const notification = notify({ title, body });
      if (!notification) return true;
      notification.on('click', () => open(itemId));
      notification.show();
      shown.push({ itemId, title, body });
      return true;
    },
    /** The heads-ups shown so far, for the end-to-end tests' hook. */
    shown: (): ShownHeadsUp[] => [...shown],
    /** Opens what a shown heads-up is about, as clicking it does (the end-to-end tests' hook). */
    click(index: number) {
      const found = shown[index];
      if (found) open(found.itemId);
    },
  };
}
