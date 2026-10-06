// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { EmailDetail } from '@commander/domain';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onReveal } from '../../frame/reveal';
import type { ItemChanges } from '../../item-store/changes';
import type { ItemStoreClient } from '../../item-store/client';
import { openTestItemStore } from '../../item-store/test-item-store';
import { ProjectsProvider } from '../../projects/context';
import { type ProjectsClient, projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes } from '../../shortcuts/react';
import { emailTodoDraft, makeEmailTodo } from '../email/email-todo';
import { FrameControlsProvider, SectionProvider } from '../section';
import { todos as definition } from '.';
import { TodosSheet } from './TodosSheet';
import { type Todos, todosIn } from './todos';

// Todos the User made from an email (#140) in the Todos Section: labelled "From email · <sender>",
// and their made-from Link opens the thread in the Email Section. A real Item store on a temporary
// database.

let store: ItemStore;
let itemStore: ItemStoreClient;
let todos: Todos;
let projects: ProjectsClient;
let changes: ItemChanges;
let close: () => void;
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };

const detail = (fields: Partial<EmailDetail>): EmailDetail => ({
  kind: 'email',
  messageId: '<offsite@mail.test>',
  inReplyTo: null,
  references: [],
  threadKey: 'mid:<offsite@mail.test>',
  sourceThreadId: 'offsite',
  from: { name: 'Dana Reyes', address: 'dana@northwind.test' },
  to: [{ name: 'Alex Kim', address: 'alex@gmail.test' }],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: 'Re: Q4 offsite dates',
  sentAt: 1_000,
  snippet: '',
  read: true,
  starred: false,
  inInbox: true,
  sentByMe: false,
  labels: [],
  attachments: [],
  hasInvitation: false,
  listUnsubscribe: null,
  listId: null,
  ...fields,
});

beforeEach(() => {
  const opened = openTestItemStore();
  ({ store, close, changes } = opened);
  itemStore = opened.client;
  todos = todosIn(opened.client);
  projects = projectsIn(opened.client);
  localStorage.clear();
  controls.openSection.mockReset();
  Element.prototype.scrollIntoView = () => {};
  store.saveFromSource({
    source: 'gmail',
    account: 'google:alex',
    items: [
      { externalId: 'dana', kind: 'email', title: 'Re: Q4 offsite dates', detail: detail({}) },
      {
        externalId: 'mine',
        kind: 'email',
        title: 'Re: Q4 offsite dates',
        detail: detail({
          messageId: '<mine@mail.test>',
          from: { name: 'Alex Kim', address: 'alex@gmail.test' },
          sentByMe: true,
          sentAt: 2_000,
        }),
      },
    ],
  });
});

afterEach(() => {
  cleanup();
  close();
});

const email = (externalId: string) => {
  const found = store.query({ kinds: ['email'] }).find((item) => item.externalId === externalId);
  if (!found) throw new Error(`No email ${externalId}`);
  return found;
};

function Active({ children }: { children: ReactNode }) {
  useActiveScopes(['todos']);
  return children;
}

function renderSheet() {
  return render(
    <ShortcutProvider>
      <ProjectsProvider client={projects} storage={localStorage}>
        <FrameControlsProvider value={controls}>
          <SectionProvider place={{ definition, number: 3, total: 8, active: true }}>
            <ShortcutScope scope="todos" group="Todos">
              <Active>
                <TodosSheet todos={todos} changes={changes} />
              </Active>
            </ShortcutScope>
          </SectionProvider>
        </FrameControlsProvider>
      </ProjectsProvider>
    </ShortcutProvider>,
  );
}

describe('a Todo made from an email', () => {
  it('is drafted from the latest message someone else wrote, titled without “Re:”, under the thread’s Project', () => {
    const latest = { ...email('mine'), filing: { projectId: 'p-lt', filedBy: 'user' as const } };
    const draft = emailTodoDraft({ subject: 'Re: Q4 offsite dates', latest }, [
      { item: email('dana'), body: null },
      { item: latest, body: null },
    ]);
    expect(draft).toEqual({
      emailId: email('dana').id,
      title: 'Q4 offsite dates',
      filing: { projectId: 'p-lt', filedBy: 'inherited' },
      sender: 'Dana Reyes',
    });
    // Without the messages, the latest it knows.
    expect(emailTodoDraft({ subject: 'Hello', latest: email('mine') })).toMatchObject({
      emailId: email('mine').id,
      sender: 'me',
      filing: null,
    });
  });

  it('won’t be made empty', async () => {
    await expect(
      makeEmailTodo(itemStore, { emailId: email('dana').id, title: '  ', filing: null, sender: '' }),
    ).rejects.toThrow('A Todo can’t be empty');
    expect(store.query({ kinds: ['todo'] })).toEqual([]);
  });

  it('is labelled “From email · <sender>”, and its Link opens the thread', async () => {
    const [made] = await makeEmailTodo(itemStore, {
      emailId: email('dana').id,
      title: 'Pick the offsite dates',
      filing: null,
      sender: 'Dana Reyes',
    });
    const madeFrom = await todos.madeFrom(await todos.list());
    expect(madeFrom.get(made?.itemId ?? '')).toEqual({ emailId: email('dana').id, sender: 'Dana Reyes' });

    const revealed: string[] = [];
    const stop = onReveal('email', (itemId) => revealed.push(itemId));
    renderSheet();
    const open = () => screen.getByRole('region', { name: 'Open' });
    await waitFor(() =>
      expect(within(open()).getAllByRole('listitem')[0]?.textContent).toContain('From email · Dana Reyes'),
    );
    await act(() => {
      fireEvent.keyDown(document.body, { key: 'Enter' });
    });
    const pane = screen.getByRole('region', { name: 'Todo detail' });
    expect(within(pane).getByText('Origin').nextSibling?.textContent).toBe('From email · Dana Reyes');
    const links = within(pane).getByRole('region', { name: 'Links' });
    fireEvent.click(await within(links).findByRole('button', { name: /Made from.*Q4 offsite dates/ }));
    expect(controls.openSection).toHaveBeenCalledWith('email');
    expect(revealed).toEqual([email('dana').id]);
    stop();
  });
});
