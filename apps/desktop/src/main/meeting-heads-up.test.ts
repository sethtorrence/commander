import type { CoreMessage } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { createMeetingHeadsUp, type HeadsUpNotification } from './meeting-heads-up';

// The heads-up's main-process half (#128): the Core says a meeting starts in 2 minutes (only when the
// User turned it on), and this shows a system notification with its title and time, which opens it.

function fakeNotifications() {
  const shown: { title: string; body: string; click(): void }[] = [];
  const notify = ({ title, body }: { title: string; body: string }): HeadsUpNotification => {
    let onClick = () => {};
    return {
      on: (_event, listener) => {
        onClick = listener;
      },
      show: () => shown.push({ title, body, click: () => onClick() }),
    };
  };
  return { shown, notify };
}

const headsUp: CoreMessage = {
  type: 'meeting-heads-up',
  itemId: 'e-1',
  title: 'Weekly sync with Priya',
  times: '10:00–10:30',
  startsAt: 0,
};

describe('the meeting heads-up', () => {
  it('shows the meeting’s title and time, and nothing else', () => {
    const { shown, notify } = fakeNotifications();
    const opened: string[] = [];
    const heads = createMeetingHeadsUp({ notify, open: (itemId) => opened.push(itemId) });
    expect(heads.handle(headsUp)).toBe(true);
    expect(shown.map(({ title, body }) => ({ title, body }))).toEqual([
      { title: 'Weekly sync with Priya', body: '10:00–10:30 · starts in 2 minutes' },
    ]);
    expect(heads.shown()).toEqual([
      { itemId: 'e-1', title: 'Weekly sync with Priya', body: '10:00–10:30 · starts in 2 minutes' },
    ]);
    expect(opened).toEqual([]);
  });

  it('opens the event when clicked', () => {
    const { shown, notify } = fakeNotifications();
    const opened: string[] = [];
    createMeetingHeadsUp({ notify, open: (itemId) => opened.push(itemId) }).handle(headsUp);
    shown[0]?.click();
    expect(opened).toEqual(['e-1']);
  });

  it('leaves every other message alone, and does nothing where notifications aren’t supported', () => {
    const { shown, notify } = fakeNotifications();
    const heads = createMeetingHeadsUp({ notify, open: () => {} });
    expect(heads.handle({ type: 'heartbeat', beats: 1, at: 0 })).toBe(false);
    expect(createMeetingHeadsUp({ notify: () => null, open: () => {} }).handle(headsUp)).toBe(true);
    expect(shown).toEqual([]);
  });
});
