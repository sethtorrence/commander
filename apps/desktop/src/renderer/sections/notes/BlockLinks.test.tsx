// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { BlockLinkTarget, EmailDetail, Item, Project, SourceItem } from '@commander/domain';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemStoreClient } from '../../item-store/client';
import { openTestItemStore } from '../../item-store/test-item-store';
import { chipLabel } from '../../links/block-text';
import { dayTargets, emailTargets, projectTargets } from '../../links/link-targets';
import { placeCaret } from './caret';
import { dailyNotesIn } from './daily-notes';
import { createNotebook, type Notebook } from './notebook';
import { OutlineContext, type OutlineControls, OutlineView } from './OutlineView';

// The `[[` picker and chips in the outliner, on a real Item store.

const today = '2026-10-03';
let store: ItemStore;
let client: ItemStoreClient;
let close: () => void;
let notebook: Notebook;
let longtail: Project;

beforeEach(async () => {
  ({ store, client, close } = openTestItemStore());
  store.saveDailyTemplate({ blocks: [] });
  const made = store.changeProject({
    type: 'create',
    project: { name: 'Longtail', code: 'LT', accent: 'blue' },
  }).project;
  if (!made) throw new Error('No Project');
  longtail = made;
  notebook = createNotebook(dailyNotesIn(client), { today });
  await notebook.start();
});

afterEach(async () => {
  cleanup();
  await notebook.flush();
  close();
});

function Outline({ open, emails = [] }: { open: (target: BlockLinkTarget) => void; emails?: Item[] }) {
  const day = notebook.snapshot().days[0];
  const controls: OutlineControls = {
    notebook,
    focus(caret) {
      const element = caret && document.querySelector<HTMLElement>(`[data-block-id="${caret.id}"]`);
      if (element && caret) placeCaret(element, caret.offset);
    },
    links: {
      providers: [dayTargets(today), projectTargets([longtail]), emailTargets(emails, today)],
      label: (target) =>
        chipLabel(target, {
          today,
          projectById: () => longtail,
          emailById: (id) => emails.find((email) => email.id === id),
        }),
      open,
    },
  };
  return (
    <OutlineContext.Provider value={controls}>
      <div data-notes-stream="">
        {day && <OutlineView day={today} outline={day.outline} placeholder="Empty" />}
      </div>
    </OutlineContext.Provider>
  );
}

// Shows the outline with one Block holding `text`, and returns its editable element.
function showBlock(text: string, open = vi.fn(), emails: Item[] = []) {
  const { id } = notebook.begin(today, text);
  const view = render(<Outline open={open} emails={emails} />);
  const rerender = () => view.rerender(<Outline open={open} emails={emails} />);
  notebook.subscribe(() => act(rerender));
  const element = document.querySelector<HTMLElement>(`[data-block-id="${id}"]`);
  if (!element) throw new Error('No Block shown');
  return { id, element, open };
}

// Types into the Block as the browser would: the new text, the caret at its end, then an input event.
function typeInto(element: HTMLElement, text: string) {
  element.textContent = text;
  element.focus();
  placeCaret(element, text.length);
  fireEvent.input(element);
}

describe('the [[ picker', () => {
  it('opens on [[ with days and Projects, narrows as the User types, and Enter makes a chip and a Link', async () => {
    const { id, element } = showBlock('See');

    typeInto(element, 'See [[');
    const picker = await screen.findByRole('listbox', { name: 'Link to' });
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['[[TodaySat 3 Oct', '[[YesterdayFri 2 Oct', 'LTLongtail']);

    typeInto(element, 'See [[thu');
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(element, { key: 'Enter' });

    await waitFor(() => expect(element.textContent).toBe('See [[2026-10-01]]'));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(within(element).getByRole('link', { name: 'Thu 1 Oct' })).toBeTruthy();
    await notebook.flush();
    expect(store.get(id)?.links).toMatchObject([{ type: 'refers-to', to: { kind: 'daily-note' } }]);
  });

  it('moves the choice with the arrow keys, and Escape closes it without changing the text', async () => {
    const { element } = showBlock('');
    typeInto(element, '[[');
    await screen.findByRole('listbox');

    fireEvent.keyDown(element, { key: 'ArrowDown' });
    fireEvent.keyDown(element, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { selected: true }).textContent).toBe('LTLongtail');

    fireEvent.keyDown(element, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(element.textContent).toBe('[[');
    // Typing on after it doesn't bring it back for the same [[.
    typeInto(element, '[[x');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('chooses a Project with a click', async () => {
    const { id, element } = showBlock('');
    typeInto(element, 'For [[lo');
    fireEvent.click(await screen.findByRole('option', { name: /Longtail/ }));

    await waitFor(() => expect(within(element).getByRole('link', { name: 'Longtail' })).toBeTruthy());
    await notebook.flush();
    expect(store.get(id)?.links).toMatchObject([{ to: { kind: 'project', id: longtail.id } }]);
  });
});

// An email from Gmail, saved as a sync saves it. Returns its Item.
function saveEmail(externalId: string, subject: string): Item {
  const detail: EmailDetail = {
    kind: 'email',
    messageId: `<${externalId}@mail.test>`,
    inReplyTo: null,
    references: [],
    threadKey: `mid:<${externalId}@mail.test>`,
    sourceThreadId: null,
    from: { name: 'Dana Whitfield', address: 'dana@northwind.test' },
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject,
    sentAt: new Date(2026, 9, 1, 9, 5).getTime(),
    snippet: '',
    read: true,
    starred: false,
    inInbox: true,
    sentByMe: false,
    labels: [{ id: 'INBOX', name: 'Inbox' }],
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
  };
  const item: SourceItem = { externalId, kind: 'email', title: subject, people: [], status: 'open', detail };
  store.saveFromSource({ source: 'gmail', account: 'google:alex', items: [item], deleted: [] });
  const saved = store.query({ kinds: ['email'], titleContains: subject })[0];
  if (!saved) throw new Error('No email');
  return saved;
}

describe('an email link', () => {
  it('is found by the [[ picker by subject or sender, and shows as its live card, which opens it', async () => {
    const budget = saveEmail('m-1', 'Q4 budget');
    const { id, element, open } = showBlock('', vi.fn(), [budget]);

    typeInto(element, 'Answer [[dana budget');
    const picker = await screen.findByRole('listbox', { name: 'Link to' });
    const group = within(picker).getByRole('group', { name: 'Emails' });
    expect(within(group).getByRole('option').textContent).toBe('[[Q4 budgetDana Whitfield · 1 Oct');
    fireEvent.keyDown(element, { key: 'Enter' });

    await waitFor(() => expect(element.textContent).toBe(`Answer [[email:${budget.id}]]`));
    const card = within(element).getByRole('link', { name: 'Email from Dana Whitfield: Q4 budget, 1 Oct' });
    await notebook.flush();
    expect(store.get(id)?.links).toMatchObject([{ type: 'refers-to', to: { kind: 'email', id: budget.id } }]);

    fireEvent.click(card);
    expect(open).toHaveBeenCalledWith({ type: 'email', emailId: budget.id });
  });
});

describe('a chip', () => {
  it('follows its target when clicked', () => {
    const { element, open } = showBlock(`On [[project:${longtail.id}]] and [[2026-10-01]]`);

    fireEvent.click(within(element).getByRole('link', { name: 'Longtail' }));
    fireEvent.click(within(element).getByRole('link', { name: 'Thu 1 Oct' }));

    expect(open.mock.calls).toEqual([
      [{ type: 'project', projectId: longtail.id }],
      [{ type: 'day', day: '2026-10-01' }],
    ]);
  });

  it('goes whole with Backspace just after it, with its Link', async () => {
    const { id, element } = showBlock('See [[2026-10-01]]');
    await notebook.flush();
    expect(store.get(id)?.links).toHaveLength(1);

    element.focus();
    placeCaret(element, 'See [[2026-10-01]]'.length);
    fireEvent.keyDown(element, { key: 'Backspace' });

    await waitFor(() => expect(element.textContent).toBe('See '));
    await notebook.flush();
    expect(store.get(id)?.links).toEqual([]);
  });
});
