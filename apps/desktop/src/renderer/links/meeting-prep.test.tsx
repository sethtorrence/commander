// @vitest-environment jsdom
import type { EventDetail, Item, MeetingPrep } from '@commander/domain';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrepBody, prepReadyLabel } from './meeting-prep';

// A meeting's prep as the window draws it (#130): Ares's lines under their headings, each through
// AresText (a URL clickable only when the Items it came from hold it) with the Items it rests on.

afterEach(cleanup);

const base = {
  source: null,
  account: null,
  externalId: null,
  people: [],
  filing: null,
  status: 'open' as const,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
};

const invite: Item = {
  ...base,
  id: 'event-1',
  kind: 'event',
  source: 'google-calendar',
  title: 'Weekly sync with Priya',
  detail: {
    kind: 'event',
    description: 'Agenda: https://docs.example.test/agenda',
  } as unknown as EventDetail,
};
const issue: Item = {
  ...base,
  id: 'issue-1',
  kind: 'linear-issue',
  source: 'linear',
  title: 'Audit log export',
  detail: null,
};

const prep: MeetingPrep = {
  ...base,
  id: 'prep-1',
  kind: 'meeting-prep',
  title: 'Prep: Weekly sync with Priya',
  detail: {
    kind: 'meeting-prep',
    eventId: 'event-1',
    revision: 'r',
    preparedAt: new Date(2026, 9, 5, 14, 30).getTime(),
    about: { text: 'The agenda is at https://docs.example.test/agenda', sources: ['event-1'] },
    lastTime: [],
    open: [{ text: 'Audit log export waits on Priya, see https://evil.example.test', sources: ['issue-1'] }],
    raise: [],
  },
};

describe('a prep', () => {
  it('shows each line under its heading with the Items it rests on, opening them', () => {
    const open = vi.fn();
    render(
      <PrepBody
        prep={prep}
        sources={
          new Map([
            ['event-1', invite],
            ['issue-1', issue],
          ])
        }
        onOpenSource={open}
      />,
    );
    const about = screen.getByRole('region', { name: 'About' });
    expect(about.textContent).toContain('The agenda is at');
    expect(screen.getByRole('region', { name: 'Open' }).textContent).toContain(
      'Audit log export waits on Priya',
    );
    expect(screen.queryByRole('region', { name: 'Last time' })).toBeNull();
    fireEvent.click(within(about).getByTestId('prep-source'));
    expect(open).toHaveBeenCalledWith(invite);
  });

  it('makes a link clickable only when the Items it came from hold it', () => {
    render(
      <PrepBody
        prep={prep}
        sources={
          new Map([
            ['event-1', invite],
            ['issue-1', issue],
          ])
        }
        onOpenSource={() => {}}
      />,
    );
    const links = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(links).toEqual(['https://docs.example.test/agenda']);
  });

  it('says when it was made', () => {
    expect(prepReadyLabel(prep)).toBe('Ready · 14:30');
  });
});
