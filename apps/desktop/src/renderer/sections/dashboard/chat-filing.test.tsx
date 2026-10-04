// @vitest-environment jsdom
import type { ActivityEntry, Item, Project } from '@commander/domain';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectsProvider } from '../../projects/context';
import type { ProjectsClient } from '../../projects/projects';
import { ShortcutProvider } from '../../shortcuts/react';
import { chat, TEAMS } from '../teams/test-chats';
import { RankedList } from './RankedList';

// A Chat on the Dashboard wears Ares's dashed Badge while his filing suggestion waits (#108), as
// any ranked Item does: the Dashboard's rows read `filingSuggestion` whatever the Item's kind.

afterEach(cleanup);

const tl: Project = {
  id: 'p-tl',
  code: 'TL',
  name: 'Titanlink',
  accent: 'teal',
  order: 0,
  archived: false,
  createdAt: 0,
};

const client: ProjectsClient = {
  list: async () => [tl],
  create: vi.fn(),
  change: vi.fn(),
  file: vi.fn(async () => ({}) as ActivityEntry),
  settleFiling: vi.fn(async () => null),
};

const saved = chat({ id: '19:relay', title: 'Relay rollout' });
const item: Item = {
  id: 'chat-1',
  kind: 'chat',
  source: 'teams',
  account: TEAMS,
  externalId: saved.externalId,
  title: saved.title,
  status: 'open',
  filing: null,
  filingSuggestion: { proposalId: 7, projectId: tl.id },
  detail: saved.detail ?? null,
  people: [],
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
} as Item;

describe('a Chat on the Dashboard', () => {
  it('wears the dashed Badge of the Project Ares suggests', async () => {
    const noop = () => {};
    render(
      <ShortcutProvider>
        <ProjectsProvider client={client} storage={localStorage}>
          <RankedList
            rows={[{ item, band: 'today', reason: 'Priya asked you', rank: 1, done: false }]}
            selectedId={null}
            now={0}
            empty="Nothing here"
            onSelect={noop}
            onOpen={noop}
            onTick={noop}
            onClear={noop}
            onSettle={noop}
          />
        </ProjectsProvider>
      </ShortcutProvider>,
    );
    const list = screen.getByTestId('ranked-list');
    expect(await within(list).findByRole('img', { name: 'Ares suggests Titanlink' })).toBeTruthy();
  });
});
