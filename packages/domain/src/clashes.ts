import type { EventDetail } from './calendar';
import type { Item } from './items';

/*
  Clashes (#127): two events from different Accounts that overlap while the User is busy in both.
  Clashes inside one Account are left alone, as Google Calendar and Outlook already show those.

  - Busy means a timed event (all-day ones mark days, not hours), shown as busy (not free), that the
    User hasn't declined and that isn't cancelled. Tentative and unanswered invitations count.
  - Overlapping means sharing some time: back-to-back events don't clash.
  - One meeting the User is invited to through both Accounts (the same title, start and end) is taken
    for one meeting seen twice, not a clash.

  Double-bookings (#129) use the same rules, but across every Account and calendar, the same Account
  included: `overlapping` finds what double-books the User with an invitation, for Ares to judge.
*/

export type ClashingEvent = Pick<Item, 'id' | 'account' | 'title' | 'deletedAt'> & {
  detail: EventDetail;
};

/** Whether an event keeps the User busy, for clashes: timed, busy, not declined, not cancelled. */
export function busyForClashes(event: ClashingEvent): boolean {
  const { detail } = event;
  return (
    event.deletedAt === null &&
    event.account !== null &&
    !detail.allDay &&
    detail.busy &&
    detail.myResponse !== 'declined' &&
    detail.end.at > detail.start.at
  );
}

const sameMeeting = (a: ClashingEvent, b: ClashingEvent) =>
  a.detail.start.at === b.detail.start.at &&
  a.detail.end.at === b.detail.end.at &&
  a.title.trim().toLowerCase() === b.title.trim().toLowerCase();

/**
 * Each clashing event's id, with the events it clashes with (in start order). Events that clash with
 * nothing aren't in the map.
 */
export function findClashes<Event extends ClashingEvent>(events: readonly Event[]): Map<string, Event[]> {
  const busy = events
    .filter(busyForClashes)
    .sort((a, b) => a.detail.start.at - b.detail.start.at || a.detail.end.at - b.detail.end.at);
  const found = new Map<string, Event[]>();
  const add = (event: Event, other: Event) => {
    const list = found.get(event.id) ?? [];
    list.push(other);
    found.set(event.id, list);
  };
  // A sweep in start order: each event meets only those still running when it starts.
  let running: Event[] = [];
  for (const event of busy) {
    running = running.filter((other) => other.detail.end.at > event.detail.start.at);
    for (const other of running) {
      if (other.account === event.account || sameMeeting(other, event)) continue;
      add(other, event);
      add(event, other);
    }
    running.push(event);
  }
  for (const list of found.values()) list.sort((a, b) => a.detail.start.at - b.detail.start.at);
  return found;
}

/**
 * The events that double-book the User with an invitation (#129): those keeping them busy (as for
 * clashes) that share some of its time, from every Account and calendar, the same one included,
 * earliest first. The invitation itself, and the same meeting seen twice, aren't among them.
 */
export function overlapping<Event extends ClashingEvent>(
  invitation: ClashingEvent,
  events: readonly Event[],
): Event[] {
  const { start, end } = invitation.detail;
  return events
    .filter(
      (other) =>
        other.id !== invitation.id &&
        busyForClashes(other) &&
        other.detail.start.at < end.at &&
        other.detail.end.at > start.at &&
        !sameMeeting(other, invitation),
    )
    .sort((a, b) => a.detail.start.at - b.detail.start.at || a.detail.end.at - b.detail.end.at);
}
