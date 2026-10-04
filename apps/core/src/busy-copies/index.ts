// Block time across Accounts (#131): with a pair switched on in Settings → Calendar ("personal Google →
// work Microsoft"), each busy event in the first Account gets a copy on the second Account's main
// calendar, so nobody books over it there. The copy is titled "Busy", private and busy, and carries
// nothing else of its event (no title, place, notes, guests or reminders): the Item store makes it so,
// whatever is asked. It moves and goes with its event, and goes when the pair is switched off.
//
// - Copies are made through the gate, as Tidy your Sources / "Block time across Accounts": switching a
//   pair on sets that action to Auto in the Autonomy grid (asking about every copy would defeat it),
//   where the User can change it; at Ask each copy waits as a suggestion on its event, and one dismissed
//   isn't offered again. Moving and removing an existing copy follows its event with no new decision.
// - No loops: Commander's own events (focus blocks, and copies, by their marker or by the Item store's
//   record of every copy it made) are never copied. A copy the User deleted at its Source, or an undone
//   one, isn't put back.
// - Only what is still to come, over the next 8 weeks: copying a year of recurring instances would
//   crowd the other calendar for little use, and later weeks are copied as they come into range.
import { type FocusSettings, holdsTime, type Item, type RegisteredAction } from '@commander/domain';
import type { Gate } from '../autonomy/gate';
import type { BusyCopy, ItemStore } from '../item-store';

export const BLOCK_TIME_ACROSS_ACCOUNTS = 'block-time-across-accounts';
export const BLOCK_TIME_ACROSS_ACCOUNTS_ACTION: RegisteredAction = {
  action: BLOCK_TIME_ACROSS_ACCOUNTS,
  actionKind: 'tidy-sources',
  name: 'Block time across Accounts',
  hint: 'Busy copies of your events on your other Accounts (Settings → Calendar)',
};

// How far ahead events are copied.
export const COPY_AHEAD_DAYS = 56;
const DAY_MS = 24 * 60 * 60_000;

export type BusyCopying = {
  // Brings the copies in step with the events and the pairs; returns the Items it changed.
  reconcile(): string[];
  // Settings → Calendar was saved: a pair switched on sets the action to Auto, and copies follow.
  settingsSaved(before: FocusSettings, after: FocusSettings): string[];
};

export type BusyCopiesOptions = {
  store: ItemStore;
  gate: Pick<Gate, 'registerAction' | 'propose' | 'setLevel'>;
  now?: () => number;
  log?: (message: string) => void;
};

const ares = { kind: 'ares' } as const;
const key = (from: string, to: string) => `${from}\u0000${to}`;

export function setUpBusyCopies({
  store,
  gate,
  now = Date.now,
  log = (message) => console.warn(message),
}: BusyCopiesOptions): BusyCopying {
  gate.registerAction(BLOCK_TIME_ACROSS_ACCOUNTS_ACTION);

  // Whether an event should have a copy: it holds the User's time, is still to come, and isn't one of
  // Commander's own.
  function wanted(event: Item, copies: ReadonlySet<string>, at: number): boolean {
    const detail = event.detail;
    if (event.deletedAt !== null || detail?.kind !== 'event') return false;
    if (detail.createdByCommander !== null || copies.has(event.id)) return false;
    return holdsTime(detail) && detail.end.at > at;
  }

  // Whether a suggestion to copy this event to this Account is waiting, or was turned down.
  function alreadyOffered(eventId: string, target: string): boolean {
    return store.autonomy
      .proposals({ itemId: eventId, action: BLOCK_TIME_ACROSS_ACCOUNTS, statuses: ['pending', 'dismissed'] })
      .some((record) =>
        record.itemActions.some((step) => step.type === 'create-event' && step.event.account === target),
      );
  }

  function reconcile(): string[] {
    const changed: string[] = [];
    const at = now();
    const pairs = store.focusSettings.read().blockPairs.filter((pair) => pair.on);
    const on = new Set(pairs.map((pair) => key(pair.from, pair.to)));
    const copies = store.busyCopies.list();
    const copyIds = new Set(copies.map((copy) => copy.copyId));
    const made = new Set(copies.map((copy) => key(copy.eventId, copy.targetAccount)));

    // Each copy follows its event: moved with it, gone with it (or with its pair).
    for (const copy of copies) {
      try {
        const done = follow(copy, on, copyIds, at);
        if (done) changed.push(copy.copyId);
      } catch (error) {
        log(`Couldn’t keep a busy copy in step with its event: ${String(error)}`);
      }
    }

    // Each wanted event without a copy gets one, through the gate.
    for (const pair of pairs) {
      const events = store.events({ from: at, to: at + COPY_AHEAD_DAYS * DAY_MS, accounts: [pair.from] });
      for (const event of events) {
        if (!wanted(event, copyIds, at) || made.has(key(event.id, pair.to))) continue;
        if (alreadyOffered(event.id, pair.to)) continue;
        const detail = event.detail;
        if (detail?.kind !== 'event') continue;
        try {
          const outcome = gate.propose({
            actionKind: 'tidy-sources',
            action: BLOCK_TIME_ACROSS_ACCOUNTS,
            section: 'calendar',
            itemId: event.id,
            itemActions: [
              {
                type: 'create-event',
                event: {
                  kind: 'busy-block',
                  account: pair.to,
                  title: 'Busy',
                  start: detail.start,
                  end: detail.end,
                  allDay: detail.allDay,
                  copyOf: event.id,
                },
              },
            ],
            confidence: 1,
            reason: 'Blocks the time on your other calendar, so nobody books over it.',
          });
          if (outcome.decision !== 'off') changed.push(event.id);
          made.add(key(event.id, pair.to));
        } catch (error) {
          log(`Couldn’t copy an event as busy time: ${String(error)}`);
        }
      }
    }
    return changed;
  }

  // Moves or removes one copy to match its event. Returns whether it changed.
  function follow(copy: BusyCopy, on: ReadonlySet<string>, copyIds: ReadonlySet<string>, at: number) {
    const item = store.get(copy.copyId)?.item;
    // Deleted at its Source by the User, or undone: left as it is, and not made again.
    if (!item || item.deletedAt !== null || item.detail?.kind !== 'event') return false;
    const event = store.get(copy.eventId)?.item;
    const stillWanted =
      !!event &&
      !!event.account &&
      on.has(key(event.account, copy.targetAccount)) &&
      // A copy already made isn't removed just because its event has started.
      wanted(event, copyIds, Math.min(at, item.detail.end.at - 1));
    if (!stillWanted || event?.detail?.kind !== 'event') {
      store.record(
        { type: 'delete', itemId: copy.copyId },
        { by: ares, why: 'Its event is gone, or no longer blocks the time there' },
      );
      return true;
    }
    const { start, end, allDay } = event.detail;
    const was = item.detail;
    if (was.start.at === start.at && was.end.at === end.at && was.allDay === allDay) return false;
    store.moveEvent(copy.copyId, { start, end, allDay }, { by: ares, why: 'Its event moved' });
    return true;
  }

  return {
    reconcile,

    settingsSaved(before, after) {
      const wasOn = new Set(
        before.blockPairs.filter((pair) => pair.on).map((pair) => key(pair.from, pair.to)),
      );
      const switchedOn = after.blockPairs.some((pair) => pair.on && !wasOn.has(key(pair.from, pair.to)));
      if (switchedOn) {
        try {
          gate.setLevel({ scope: 'action', action: BLOCK_TIME_ACROSS_ACCOUNTS }, 'auto');
        } catch (error) {
          log(`Couldn’t set Block time across Accounts to Auto: ${String(error)}`);
        }
      }
      return reconcile();
    },
  };
}
