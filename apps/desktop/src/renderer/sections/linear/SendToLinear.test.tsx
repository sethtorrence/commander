// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { LinearIssueDetail } from '@commander/domain';
import type { AccountSummary } from '@commander/domain/ipc';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestItemStore } from '../../item-store/test-item-store';
import type { LinearAccountsClient } from './linear-issues';
import { useSendToLinear } from './SendToLinear';
import { linearSenderIn, type SendTarget } from './send-to-linear';
import { ACME, ENG, PRIYA, SAM, STATES } from './test-issues';

// The Send to Linear dialog against a real Item store: it starts from the Todo's title and the
// workspace's team, and sends the issue.

let store: ItemStore;
let client: ReturnType<typeof openTestItemStore>['client'];
let close: () => void;

const acme: AccountSummary = {
  id: ACME,
  source: 'linear',
  name: 'Acme',
  urlKey: 'acme',
  method: 'api-key',
  status: 'connected',
  user: { id: SAM.id, name: SAM.name },
  sync: null,
};
const accountsOf = (list: AccountSummary[]): LinearAccountsClient => ({
  list: async () => list,
  syncNow: async () => {},
  onChange: () => () => {},
});

function Harness({ target, accounts }: { target: SendTarget; accounts: LinearAccountsClient }) {
  const send = useSendToLinear({ sender: linearSenderIn(client), accounts });
  return (
    <>
      <button type="button" onClick={() => send.open(target)}>
        Open
      </button>
      {send.dialog}
    </>
  );
}

beforeEach(() => {
  ({ store, client, close } = openTestItemStore());
  store.syncState.saveCatalog(
    ACME,
    'linear',
    {
      kind: 'linear',
      teams: [
        {
          ...ENG,
          states: Object.values(STATES),
          members: [SAM, PRIYA],
          labels: [],
          cycles: [],
          linearProjects: [],
        },
      ],
    },
    1,
  );
});

afterEach(() => {
  cleanup();
  close();
});

describe('the Send to Linear dialog', () => {
  it('starts from the Todo’s title, on the workspace’s team, assigned to the User, and sends the issue', async () => {
    const todo = store.record(
      {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'Write the runbook',
          detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null },
        },
      },
      { by: { kind: 'user' } },
    );
    render(<Harness target={{ from: todo.itemId }} accounts={accountsOf([acme])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    const title = await screen.findByLabelText('Title');
    expect(title).toHaveProperty('value', 'Write the runbook');
    expect(screen.getByRole('combobox', { name: 'Team' }).textContent).toContain('ENG · Engineering');
    expect(screen.getByRole('combobox', { name: 'Assignee' }).textContent).toContain('Sam Rivera (you)');
    expect(screen.getByRole('combobox', { name: 'State' }).textContent).toContain('Todo');

    fireEvent.change(title, { target: { value: 'Write the deploy runbook' } });
    fireEvent.click(screen.getByRole('button', { name: /^Send to Linear/ }));

    await waitFor(() => expect(store.query({ kinds: ['linear-issue'] })).toHaveLength(1));
    const [issue] = store.query({ kinds: ['linear-issue'] });
    expect(issue?.title).toBe('Write the deploy runbook');
    expect((issue?.detail as LinearIssueDetail | undefined)?.assignee?.id).toBe(SAM.id);
    await waitFor(() => expect(screen.queryByLabelText('Title')).toBeNull());
  });

  it('won’t send without a title', async () => {
    render(<Harness target={{}} accounts={accountsOf([acme])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByLabelText('Title');
    fireEvent.click(screen.getByRole('button', { name: /^Send to Linear/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('An issue needs a title');
    expect(store.query({ kinds: ['linear-issue'] })).toEqual([]);
  });

  it('says so when no Linear Account is connected', async () => {
    render(<Harness target={{}} accounts={accountsOf([])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText(/No Linear Account connected yet/)).toBeTruthy();
  });
});
