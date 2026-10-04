// Today's meetings in the Core (#128).
//
// - **Meeting chips:** the Item store keeps today's chips in step with today's events
//   (item-store/meeting-chips.ts); this runs it after every calendar sync, when today's Daily Note is
//   made (Notes opening, or the date passing midnight), and at start-up, and tells the window which
//   Items changed so Notes shows the chips.
// - **The heads-up:** when the User has turned it on (Settings → Calendar, off by default), a meeting
//   that gets a chip starting in 2 minutes is sent to the main process, once, which shows a system
//   notification. It is the one exception to "Ares never interrupts" (decision #23), so it carries the
//   meeting's title and time and nothing else, and it isn't sent while the screen is locked or the User
//   is away, when no one would see it.
import { type CoreMessage, isChipWorthy, meetingTimes, type PresenceState } from '@commander/domain';
import type { ItemStore } from '../item-store';

export const HEADS_UP_MS = 2 * 60_000;
// How often the heads-up looks for a meeting about to start.
const CHECK_EVERY_MS = 10_000;

export type MeetingsOptions = {
  store: ItemStore;
  send(message: CoreMessage): void;
  // Where the User stands (updates/presence.ts); the heads-up waits for someone to be there.
  presence(): PresenceState;
  now?: () => number;
  // Off in tests, which tick by hand.
  timers?: boolean;
};

export type Meetings = {
  // Brings today's meeting chips in step; returns the Items it changed.
  refresh(): string[];
  // Sends the heads-up for a meeting starting within 2 minutes, if the User asked for it.
  tick(): void;
  stop(): void;
};

export function setUpMeetings(options: MeetingsOptions): Meetings {
  const { store, send } = options;
  const now = options.now ?? Date.now;
  // The meetings already announced, by event and start time (a moved one is announced again).
  const announced = new Set<string>();

  function refresh(): string[] {
    let change: ReturnType<ItemStore['meetingChips']['fill']>;
    try {
      change = store.meetingChips.fill();
    } catch (error) {
      console.warn('Could not keep the meeting chips in step:', error);
      return [];
    }
    if (change.itemIds.length && change.dailyNoteId) {
      send({ type: 'items-changed', itemIds: change.itemIds });
      send({ type: 'meeting-chips', dailyNoteId: change.dailyNoteId });
    }
    return change.itemIds;
  }

  function tick() {
    if (!store.calendarSettings.read().headsUp) return;
    const presence = options.presence();
    if (presence === 'locked' || presence === 'away') return;
    const at = now();
    for (const event of store.events({ from: at, to: at + HEADS_UP_MS + 1 })) {
      if (!isChipWorthy(event)) continue;
      const { start } = event.detail;
      if (start.at <= at || start.at - HEADS_UP_MS > at) continue;
      const key = `${event.id}@${start.at}`;
      if (announced.has(key)) continue;
      announced.add(key);
      send({
        type: 'meeting-heads-up',
        itemId: event.id,
        title: event.title,
        times: meetingTimes(event.detail),
        startsAt: start.at,
      });
    }
  }

  const timer = options.timers === false ? null : setInterval(tick, CHECK_EVERY_MS);
  return {
    refresh,
    tick,
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
