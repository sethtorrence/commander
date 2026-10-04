// @vitest-environment jsdom
import { type FindTimeResult, type ItemStoreRequest, zonedTime } from '@commander/domain';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ItemStoreClient } from '../../item-store/client';
import { ShortcutProvider } from '../../shortcuts/react';
import { FindTimeHost, guestsOf, requestFindTime } from './FindTime';

// Find time (#132): who, how long and within when; up to 5 slots, with whose calendars couldn't be
// checked; the booking link for a guest outside; and picking a slot opens the meeting card, whose
// Create makes the meeting as the User.

const LONDON = 'Europe/London';
const ALEX = 'google:104512345678901234567';
const SLOT = {
  start: zonedTime('2026-10-06', '10:00', LONDON),
  end: zonedTime('2026-10-06', '10:30', LONDON),
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function stub(result: FindTimeResult) {
  const sent: ItemStoreRequest[] = [];
  const client = (async (request: ItemStoreRequest) => {
    sent.push(request);
    switch (request.op) {
      case 'find-time':
        return result;
      case 'people':
        return [];
      case 'calendars':
        return [
          {
            account: ALEX,
            source: 'google-calendar',
            id: 'alex@gmail.test',
            name: 'alex@gmail.test',
            colour: '#9fe1e7',
            primary: true,
            accessRole: 'owner',
            on: true,
          },
        ];
      case 'scheduling-settings':
        return { newEventsAccount: null, newEventsCalendar: null, bookingLink: result.bookingLink };
      case 'focus-settings':
        return {
          workingHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
          focusAccount: null,
          blockPairs: [],
        };
      case 'events':
        return [];
      case 'create-meeting':
        return { id: 1 };
      default:
        throw new Error(`Unexpected ${request.op}`);
    }
  }) as unknown as ItemStoreClient;
  return { client, sent };
}

describe('Find time', () => {
  it('reads the guests typed as addresses', () => {
    expect(guestsOf('Leo@Acme.test, dana@contoso.test;leo@acme.test')).toEqual([
      'leo@acme.test',
      'dana@contoso.test',
    ]);
    expect(guestsOf('leo')).toBeNull();
    expect(guestsOf('')).toEqual([]);
  });

  it('shows the slots, says whose calendar couldn’t be checked, and makes the meeting from the one picked', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { client, sent } = stub({
      slots: [SLOT],
      timeZone: LONDON,
      guests: [
        {
          email: 'leo@acme.test',
          checked: false,
          why: 'Outside your organisations: only your calendars were checked.',
          outside: true,
        },
      ],
      bookingLink: 'https://calendar.app.google/abc123',
    });
    render(
      <ShortcutProvider>
        <FindTimeHost itemStore={client} />
      </ShortcutProvider>,
    );
    act(() => requestFindTime());
    fireEvent.change(await screen.findByLabelText('Who'), { target: { value: 'leo@acme.test' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'How long' }), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find time' }));
    const slot = await screen.findByRole('button', { name: 'Tue 6 Oct 10:00' });
    expect(sent.find((request) => request.op === 'find-time')).toMatchObject({
      request: { attendees: ['leo@acme.test'], durationMinutes: 30 },
    });
    expect(screen.getByTestId('guest-checked').textContent).toBe(
      'leo@acme.test: Outside your organisations: only your calendars were checked.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send your booking link instead' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('Book a time here: https://calendar.app.google/abc123'),
    );

    fireEvent.click(slot);
    await waitFor(() =>
      expect(screen.getByTestId('meeting-headline').textContent).toBe(
        'Meeting with leo@acme.test · 30 min · Tue 6 Oct 10:00',
      ),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(sent.find((request) => request.op === 'create-meeting')).toMatchObject({
        draft: {
          kind: 'meeting',
          account: ALEX,
          calendarId: 'alex@gmail.test',
          title: 'Meeting with leo@acme.test',
          start: { at: SLOT.start },
          end: { at: SLOT.end },
          attendees: [{ email: 'leo@acme.test', name: null }],
        },
      }),
    );
  });
});
