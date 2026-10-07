// @vitest-environment jsdom
import type { ConversationMade, Item } from '@commander/domain';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ItemStoreClient } from '../../item-store/client';
import { ARES_REPLY_FOCUS, SUGGESTED_REPLY_FOCUS, takeReply } from '../../links/reply-handoff';
import { CommandProvider, createCommandRegistry } from '../../palette/commands';
import { ShortcutProvider } from '../../shortcuts/react';
import { UpdatesProvider } from '../../updates/context';
import type { OpenTarget } from '../../updates/updates';
import { AnswerMade } from './ConversationMade';

// What Draft, Schedule and Meeting prep made in one of Ares's answers (#198): a draft reply with Open
// in composer, which opens it where it is written and sends nothing; a reply holding the booking link;
// and a meeting's prep, read by its event, linked to it.

let opened: OpenTarget[];
let left: number;

beforeEach(() => {
  opened = [];
  left = 0;
});
afterEach(cleanup);

function show(made: ConversationMade[], itemStore?: ItemStoreClient) {
  render(
    <ShortcutProvider>
      <CommandProvider registry={createCommandRegistry()}>
        <UpdatesProvider client={undefined} onOpen={(target) => opened.push(target)}>
          <AnswerMade turn={{ made }} itemStore={itemStore} onLeave={() => left++} />
        </UpdatesProvider>
      </CommandProvider>
    </ShortcutProvider>,
  );
}

describe('a draft reply under his answer', () => {
  it('shows an email draft, and Open in composer opens the thread’s suggested reply where it is written', () => {
    show([
      {
        kind: 'email-draft',
        itemId: 'm1',
        title: 'Q4 offsite dates',
        body: 'Hi Dana,\n\nThursday works.',
        addedLinks: [],
        sure: false,
      },
    ]);
    const card = screen.getByRole('region', { name: 'Draft reply: Q4 offsite dates' });
    expect(within(card).getByTestId('conversation-draft-body').textContent).toContain('Thursday works.');
    expect(within(card).getByTestId('conversation-draft-unsure')).toBeTruthy();
    expect(card.textContent).toContain('Sent only when you press Send');
    fireEvent.click(within(card).getByRole('button', { name: 'Open in composer' }));
    expect(opened).toEqual([
      { kind: 'item', sectionId: 'email', itemId: 'm1', focus: SUGGESTED_REPLY_FOCUS },
    ]);
    // The pop-up goes once the User is taken to it.
    expect(left).toBe(1);
  });

  it('hands a Chat’s draft to its reply box, and a booking-link reply to the composer, link and all', () => {
    show([
      { kind: 'chat-draft', itemId: 'chat-1', title: 'Omar', text: 'Yes, Friday.' },
      {
        kind: 'booking-reply',
        itemId: 'm2',
        title: 'Catch up?',
        to: 'email',
        text: 'Book a time here: https://calendar.app.google/Me',
        link: 'https://calendar.app.google/Me',
      },
    ]);
    const chat = screen.getByRole('region', { name: 'Draft reply: Omar' });
    fireEvent.click(within(chat).getByRole('button', { name: 'Open in composer' }));
    expect(opened.at(-1)).toEqual({
      kind: 'item',
      sectionId: 'teams',
      itemId: 'chat-1',
      focus: ARES_REPLY_FOCUS,
    });
    expect(takeReply('chat-1')).toEqual({ text: 'Yes, Friday.' });

    const booking = screen.getByRole('region', { name: 'Reply with your booking link: Catch up?' });
    // The User's own link is the one link it may follow.
    expect(within(booking).getByRole('link', { name: 'https://calendar.app.google/Me' })).toBeTruthy();
    fireEvent.click(within(booking).getByRole('button', { name: 'Open in composer' }));
    expect(opened.at(-1)).toEqual({
      kind: 'item',
      sectionId: 'email',
      itemId: 'm2',
      focus: ARES_REPLY_FOCUS,
    });
    expect(takeReply('m2')).toEqual({
      text: 'Book a time here: https://calendar.app.google/Me',
      link: 'https://calendar.app.google/Me',
    });
    // Taken once.
    expect(takeReply('m2')).toBeNull();
  });
});

describe('a meeting’s prep under his answer', () => {
  it('reads the prep by its event and opens the event', async () => {
    const prep = {
      id: 'prep-1',
      kind: 'meeting-prep',
      title: 'Prep: Acme check-in',
      detail: {
        kind: 'meeting-prep',
        eventId: 'event-1',
        revision: 'r1',
        preparedAt: new Date(2026, 9, 6, 13, 30).getTime(),
        about: { text: 'The Acme renewal terms.', sources: ['event-1'] },
        lastTime: [],
        open: [],
        raise: [],
      },
    } as unknown as Item;
    const asked: unknown[] = [];
    const itemStore = (async (request: { op: string }) => {
      asked.push(request);
      return request.op === 'meeting-preps' ? [prep] : [];
    }) as unknown as ItemStoreClient;
    show(
      [
        {
          kind: 'meeting-prep',
          eventId: 'event-1',
          title: 'Acme check-in',
          startsAt: new Date(2026, 9, 6, 14).getTime(),
        },
      ],
      itemStore,
    );
    const card = screen.getByRole('region', { name: 'Prep: Acme check-in' });
    await waitFor(() =>
      expect(within(card).getByTestId('prep-line').textContent).toContain('Acme renewal terms'),
    );
    expect(card.textContent).toContain('Prep · 14:00');
    expect(asked[0]).toEqual({ op: 'meeting-preps', eventIds: ['event-1'] });
    fireEvent.click(within(card).getByRole('button', { name: 'Open the event Acme check-in' }));
    expect(opened).toEqual([{ kind: 'item', sectionId: 'calendar', itemId: 'event-1' }]);
  });
});
