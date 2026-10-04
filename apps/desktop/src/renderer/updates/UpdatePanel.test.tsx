// @vitest-environment jsdom
import type {
  CoreMessage,
  QueuedLine,
  UpdateSummary,
  UpdatesRequest,
  UpdateView,
  UpdateViewLine,
} from '@commander/domain';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AresStatus } from '../frame/Header';
import { CommandProvider, createCommandRegistry } from '../palette/commands';
import { ShortcutProvider } from '../shortcuts/react';
import { AresQueueCard } from './AresQueueCard';
import { UpdatesProvider, useUpdates } from './context';
import type { UpdatesClient } from './updates';

// The Update in the window, through what the User does: `U`, the header button, the tray and the
// palette command all run the Update Skill; the panel shows the three groups and acts on lines.

afterEach(cleanup);

const queued = (id: number, overrides: Partial<QueuedLine> = {}): QueuedLine => ({
  id,
  group: 'decision',
  mergeKey: `suggestions:${id}`,
  about: {
    kind: 'suggestions',
    action: 'suggest-todos',
    name: 'Suggest Todos',
    actionKind: 'organise',
    proposalIds: [id],
  },
  itemIds: [`block-${id}`],
  section: 'notes',
  importance: 0.6,
  createdAt: 1,
  updatedAt: 1,
  expiresAt: null,
  snoozedUntil: null,
  status: 'queued',
  settledAt: null,
  ...overrides,
});

const line = (
  id: number,
  text: string,
  overrides: Partial<QueuedLine> = {},
  extra: Partial<UpdateViewLine> = {},
) => {
  const q = queued(id, overrides);
  return {
    queuedId: id,
    group: q.group,
    kind: q.about.kind,
    text,
    itemIds: q.itemIds,
    section: q.section,
    sources: [],
    folded: false,
    fresh: true,
    queued: q,
    ...extra,
  } satisfies UpdateViewLine;
};

const update = (lines: UpdateViewLine[], overrides: Partial<UpdateView> = {}): UpdateView => ({
  id: 1,
  at: new Date(2026, 9, 3, 9, 30).getTime(),
  awayMs: 0,
  folded: false,
  voice: 'ares',
  lines,
  ...overrides,
});

let requests: UpdatesRequest[];
let answer: (request: UpdatesRequest) => unknown;
let listener: (message: CoreMessage) => void;
let trayListener: () => void;
let opened: unknown[];
let registry: ReturnType<typeof createCommandRegistry>;

const client = vi.fn(async (request: UpdatesRequest) => {
  requests.push(request);
  return answer(request);
}) as unknown as UpdatesClient;

beforeEach(() => {
  requests = [];
  opened = [];
  registry = createCommandRegistry();
  answer = (request) =>
    request.op === 'state' ? { queued: 0, presence: { state: 'active', since: 1 } } : null;
});

function Status() {
  const { queued, presence, ask } = useUpdates();
  return (
    <AresStatus
      queued={queued}
      presence={presence && presence.state !== 'active' ? 'away' : 'here'}
      onAsk={ask}
    />
  );
}

function renderUpdates() {
  return render(
    <ShortcutProvider>
      <CommandProvider registry={registry}>
        <UpdatesProvider
          client={client}
          onCoreMessage={(next) => {
            listener = next;
            return () => {};
          }}
          onAskForUpdate={(next) => {
            trayListener = next;
            return () => {};
          }}
          onOpen={(target) => opened.push(target)}
        >
          <Status />
          <AresQueueCard />
        </UpdatesProvider>
      </CommandProvider>
    </ShortcutProvider>,
  );
}

const panel = () => screen.queryByTestId('update-panel');
const skillRuns = () => requests.filter((request) => request.op === 'run-skill');

describe('asking for an Update', () => {
  it('nothing opens without the User asking, however the count changes', async () => {
    renderUpdates();
    act(() => listener({ type: 'ares-updates', queued: 4, presence: { state: 'active', since: 1 } }));
    expect(screen.getByTestId('ares-queued').textContent).toBe('04');
    expect(panel()).toBeNull();
    expect(skillRuns()).toEqual([]);
  });

  it('`U`, the header button, the tray item and the palette command all run the Update Skill', async () => {
    answer = (request) =>
      request.op === 'run-skill' ? update([line(1, 'One Todo I wasn’t sure about.')]) : null;
    renderUpdates();

    fireEvent.keyDown(document.body, { key: 'u' });
    await screen.findByText('One Todo I wasn’t sure about.');
    fireEvent.keyDown(panel() as HTMLElement, { key: 'Escape' });
    await waitFor(() => expect(panel()).toBeNull());

    fireEvent.click(
      within(screen.getByTestId('ares-status')).getByRole('button', { name: 'Ask for an update' }),
    );
    await screen.findByText('One Todo I wasn’t sure about.');
    fireEvent.keyDown(panel() as HTMLElement, { key: 'Escape' });
    await waitFor(() => expect(panel()).toBeNull());

    act(() => trayListener());
    await screen.findByText('One Todo I wasn’t sure about.');
    fireEvent.keyDown(panel() as HTMLElement, { key: 'Escape' });
    await waitFor(() => expect(panel()).toBeNull());

    const command = registry.available().find((each) => each.label === 'Ask for an update');
    expect(command?.keys).toBe('u');
    act(() => command?.run());
    await screen.findByText('One Todo I wasn’t sure about.');

    expect(skillRuns()).toEqual(Array(4).fill({ op: 'run-skill', skill: 'update' }));
  });

  it('the Dashboard’s queue card shows the count and asks the same way', async () => {
    renderUpdates();
    act(() => listener({ type: 'ares-updates', queued: 2, presence: { state: 'active', since: 1 } }));
    expect(screen.getByTestId('ares-queue-count').textContent).toBe('02');
    const card = screen.getByRole('region', { name: 'Ares’s queue' });
    fireEvent.click(within(card).getByRole('button', { name: /Ask for an update/ }));
    await screen.findByText('Nothing new since you last asked.');
    expect(skillRuns()).toHaveLength(1);
  });

  it('`U` does nothing while the User is typing', () => {
    renderUpdates();
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    fireEvent.keyDown(field, { key: 'u' });
    expect(skillRuns()).toEqual([]);
    field.remove();
  });

  it('with nothing queued, says so', async () => {
    renderUpdates();
    fireEvent.keyDown(document.body, { key: 'u' });
    await screen.findByText('Nothing new since you last asked.');
  });
});

describe('the Update panel', () => {
  it('shows the three groups in order, each line in Ares’s words', async () => {
    answer = (request) =>
      request.op === 'run-skill'
        ? update([
            line(3, 'Two items tried to steer me. I ignored them.', { group: 'fyi' }),
            line(1, 'One Todo I wasn’t sure about.'),
            line(2, 'Meeting prep is ready.', { group: 'now' }),
          ])
        : null;
    renderUpdates();
    fireEvent.keyDown(document.body, { key: 'u' });
    await screen.findByText('One Todo I wasn’t sure about.');
    const groups = within(panel() as HTMLElement).getAllByRole('region');
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
      'Needs you now',
      'Waiting on your decision',
      'For your information',
    ]);
  });

  it('a link the model wrote is clickable only if its source Items hold it', async () => {
    answer = (request) =>
      request.op === 'run-skill'
        ? update([
            line(
              1,
              'See https://linear.app/acme/issue/ENG-7 and https://evil.example/x',
              {},
              {
                sources: ['Ship it https://linear.app/acme/issue/ENG-7'],
              },
            ),
          ])
        : null;
    renderUpdates();
    fireEvent.keyDown(document.body, { key: 'u' });
    await screen.findByText(/See/);
    const links = within(panel() as HTMLElement).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['https://linear.app/acme/issue/ENG-7']);
  });

  it('accepting a suggestion in place acts on its line, then shows it done', async () => {
    let acted = false;
    answer = (request) => {
      if (request.op === 'act') {
        acted = true;
        return queued(1, { status: 'done' });
      }
      if (request.op === 'run-skill' || request.op === 'past') {
        return update([line(1, 'One Todo I wasn’t sure about.', acted ? { status: 'done' } : {})]);
      }
      return null;
    };
    renderUpdates();
    fireEvent.keyDown(document.body, { key: 'u' });
    await screen.findByText('One Todo I wasn’t sure about.');
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await screen.findByText('Done');
    expect(requests).toContainEqual({ op: 'act', queuedId: 1, action: 'accept' });
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it('Done, Dismiss and Snooze (later today or tomorrow) act on the line', async () => {
    answer = (request) =>
      request.op === 'run-skill' || request.op === 'past'
        ? update([line(1, 'One Todo I wasn’t sure about.')])
        : queued(1);
    renderUpdates();
    fireEvent.keyDown(document.body, { key: 'u' });
    await screen.findByText('One Todo I wasn’t sure about.');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    fireEvent.click(screen.getByRole('button', { name: 'Snooze' }));
    fireEvent.click(screen.getByRole('button', { name: 'Later today' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }));
    await waitFor(() =>
      expect(requests.filter((request) => request.op === 'act')).toEqual([
        { op: 'act', queuedId: 1, action: 'done' },
        { op: 'act', queuedId: 1, action: 'dismiss' },
        { op: 'act', queuedId: 1, action: 'snooze', snooze: 'later-today' },
        { op: 'act', queuedId: 1, action: 'snooze', snooze: 'tomorrow' },
      ]),
    );
  });

  it('Open closes the panel and goes to the Item the line is about', async () => {
    answer = (request) =>
      request.op === 'run-skill' ? update([line(1, 'One Todo I wasn’t sure about.')]) : null;
    renderUpdates();
    fireEvent.keyDown(document.body, { key: 'u' });
    await screen.findByText('One Todo I wasn’t sure about.');
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(panel()).toBeNull());
    expect(opened).toEqual([{ kind: 'item', sectionId: 'notes', itemId: 'block-1' }]);
  });

  it('a merged Linear line lists its issues, each opening its own', async () => {
    const issue = (n: number) => ({
      itemId: `issue-${n}`,
      identifier: `ENG-${n}`,
      todoId: `todo-${n}`,
      why: `ENG-${n} was reassigned to Priya Patel`,
      reassigned: true,
    });
    answer = (request) =>
      request.op === 'run-skill'
        ? update([
            line(
              1,
              '2 of your Linear issues were reassigned.',
              {
                group: 'fyi',
                about: { kind: 'linear-left', entryIds: [1, 2], issues: [issue(1), issue(2)] },
                itemIds: ['issue-1', 'issue-2'],
                section: 'linear',
              },
              { sources: ['Fix the export', 'Rotate the keys'] },
            ),
          ])
        : null;
    renderUpdates();
    fireEvent.keyDown(document.body, { key: 'u' });
    const fyi = await screen.findByRole('region', { name: 'For your information' });
    const issues = within(fyi).getByRole('list', { name: 'Its Linear issues' });
    expect(
      within(issues)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual(['ENG-1ENG-1 was reassigned to Priya Patel', 'ENG-2ENG-2 was reassigned to Priya Patel']);
    fireEvent.click(within(issues).getByRole('button', { name: 'Open ENG-2' }));
    await waitFor(() => expect(panel()).toBeNull());
    expect(opened).toEqual([{ kind: 'item', sectionId: 'linear', itemId: 'issue-2' }]);
  });

  it('after time away, leads with the most important and folds the rest by Section', async () => {
    const lines = [
      ...[1, 2, 3, 4, 5].map((id) => line(id, `Lead ${id}.`)),
      line(6, 'Small 6.', { section: 'linear' }, { folded: true }),
      line(7, 'Small 7.', { section: 'notes' }, { folded: true }),
      line(8, 'Small 8.', { section: 'linear' }, { folded: true }),
    ];
    answer = (request) =>
      request.op === 'run-skill' ? update(lines, { folded: true, awayMs: 10 * 3_600_000 }) : null;
    renderUpdates();
    fireEvent.keyDown(document.body, { key: 'u' });
    await screen.findByText('Lead 1.');
    const folded = screen.getByTestId('update-folded');
    expect(folded.querySelector('summary')?.textContent).toBe(
      'and 3 smaller things · 2 in Linear · 1 in Notes',
    );
    expect((folded as HTMLDetailsElement).open).toBe(false);
    const leadLines = within(panel() as HTMLElement)
      .getAllByTestId('update-line')
      .filter((each) => !folded.contains(each));
    expect(leadLines).toHaveLength(5);
  });

  it('says when the sentences are the plain templates', async () => {
    answer = (request) =>
      request.op === 'run-skill'
        ? update([line(1, 'Suggest Todos: one suggestion.')], { voice: 'template' })
        : null;
    renderUpdates();
    fireEvent.keyDown(document.body, { key: 'u' });
    await screen.findByText('Plain sentences: Ares’s model wasn’t available');
  });

  it('Past Updates lists every Update kept, and reopens an earlier one', async () => {
    const history: UpdateSummary[] = [
      { id: 2, at: new Date(2026, 9, 3, 9, 30).getTime(), lines: 1, folded: false, voice: 'ares' },
      { id: 1, at: new Date(2026, 9, 2, 18, 5).getTime(), lines: 3, folded: true, voice: 'ares' },
    ];
    answer = (request) => {
      if (request.op === 'run-skill') return update([line(1, 'Today’s line.')], { id: 2 });
      if (request.op === 'history') return history;
      if (request.op === 'past') return update([line(9, 'Yesterday’s line.', { status: 'done' })], { id: 1 });
      return null;
    };
    renderUpdates();
    fireEvent.keyDown(document.body, { key: 'u' });
    await screen.findByText('Today’s line.');
    fireEvent.click(screen.getByRole('button', { name: 'Past Updates' }));
    const list = await screen.findByRole('list', { name: 'Past Updates' });
    const entries = within(list).getAllByRole('button');
    expect(entries.map((entry) => entry.textContent)).toEqual([
      expect.stringContaining('1 thing'),
      expect.stringContaining('3 things · after time away'),
    ]);
    fireEvent.click(entries[1] as HTMLElement);
    await screen.findByText('Yesterday’s line.');
    expect(screen.getByText(/^Past Update ·/)).toBeTruthy();
    expect(requests).toContainEqual({ op: 'past', id: 1 });
  });
});
