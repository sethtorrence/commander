// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { Project, RuleWhen } from '@commander/domain';
import { Toaster } from '@commander/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ItemStoreClient } from '../item-store/client';
import { openTestItemStore } from '../item-store/test-item-store';
import { ProjectsProvider } from '../projects/context';
import { projectsIn } from '../projects/projects';
import { ACME, issue, OPS } from '../sections/linear/test-issues';
import { ShortcutProvider } from '../shortcuts/react';
import { RulesSettings } from './RulesSettings';

// Settings → Rules in the window, against a real Item store on a temporary database, with Linear
// issues saved as Linear sync saves them.
let store: ItemStore;
let client: ItemStoreClient;
let close: () => void;
let lt: Project;
let tl: Project;
let tx: Project;

const BUG = { id: 'label-bug', name: 'Bug', color: '#eb5757' };
const INFRA = { id: 'label-infra', name: 'infra', color: '#000000' };

beforeEach(() => {
  localStorage.clear();
  ({ store, client, close } = openTestItemStore());
  lt = create('Longtail', 'LT', 'blue');
  tl = create('Titanlink', 'TL', 'teal');
  tx = create('Tactics', 'TX', 'violet');
  store.saveFromSource({
    source: 'linear',
    account: ACME,
    items: [
      issue({ identifier: 'ENG-1', title: 'Fix the login loop', labels: [BUG] }),
      issue({ identifier: 'ENG-2', title: 'Rotate the keys', labels: [INFRA] }),
      issue({ identifier: 'OPS-1', title: 'Renew the certificate', team: OPS }),
    ],
  });
});

afterEach(() => {
  cleanup();
  close();
});

function create(name: string, code: string, accent: string) {
  return store.changeProject({ type: 'create', project: { name, code, accent } }).project as Project;
}

const idOf = (title: string) => store.query({ titleContains: title })[0]?.id ?? '';
const filingOf = (title: string) => store.get(idOf(title))?.item.filing ?? null;
const teamIs = (key: string, id: string): RuleWhen => ({
  join: 'and',
  terms: [{ field: 'linear.team', op: 'is', value: id, label: key }],
});

function renderSettings() {
  render(
    <ShortcutProvider>
      <ProjectsProvider client={projectsIn(client)} storage={localStorage}>
        <RulesSettings no="12" itemStore={client} />
      </ProjectsProvider>
      <Toaster />
    </ShortcutProvider>,
  );
}

const ruleRows = () =>
  within(screen.getByRole('list', { name: 'Rules', hidden: true }))
    .getAllByRole('listitem', { hidden: true })
    .map((row) => row.textContent);

async function openEditor() {
  fireEvent.click(await screen.findByRole('button', { name: 'New Rule' }));
  return screen.findByRole('dialog', { name: 'New Rule' });
}

// Picks a value in one of the editor's selects, once its choices have loaded.
async function choose(dialog: HTMLElement, label: string, option: string) {
  const select = within(dialog).getByRole('combobox', { name: label });
  const found = await within(select).findByRole('option', { name: option });
  fireEvent.change(select, { target: { value: (found as HTMLOptionElement).value } });
}

describe('Settings → Rules', () => {
  it('creates a Rule, offers re-filing with a preview leaving out hand-filed Items, and one Undo reverts it', async () => {
    store.record(
      {
        type: 'update',
        itemId: idOf('Rotate the keys'),
        changes: { filing: { projectId: lt.id, filedBy: 'user' } },
      },
      { by: { kind: 'user' } },
    );
    renderSettings();
    const dialog = await openEditor();

    await choose(dialog, 'Files into', 'TL · Titanlink');
    await choose(dialog, 'Value 1', 'ENG');
    const matching = within(dialog).getByRole('region', { name: 'Matching Items' });
    expect(await within(matching).findByText('Matches 2 Items')).toBeTruthy();
    expect(within(matching).getByText('Fix the login loop')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Rule' }));

    const offer = await screen.findByRole('dialog', { name: 'Re-file existing items' });
    expect(within(offer).getByText('Also re-file 1 existing item?')).toBeTruthy();
    const preview = within(offer).getByRole('list', { name: 'Re-file preview' });
    expect(
      within(preview)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual(['Fix the login loop—→TL']);
    expect(ruleRows()).toEqual([expect.stringContaining('team is ENG')]);
    expect(filingOf('Fix the login loop')).toBeNull();

    fireEvent.click(within(offer).getByRole('button', { name: 'Re-file 1 item' }));
    await waitFor(() =>
      expect(filingOf('Fix the login loop')).toEqual({ projectId: tl.id, filedBy: 'rule' }),
    );
    expect(filingOf('Rotate the keys')).toEqual({ projectId: lt.id, filedBy: 'user' });

    const toast = (await screen.findByText('Re-filed 1 item')).closest('li') as HTMLElement;
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(filingOf('Fix the login loop')).toBeNull());
  });

  it('builds AND, OR and a group of conditions', async () => {
    renderSettings();
    const dialog = await openEditor();

    await choose(dialog, 'Files into', 'TX · Tactics');
    await choose(dialog, 'Value 1', 'ENG');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add group' }));
    await choose(dialog, 'Value 2.1', 'Bug');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add condition to group 2' }));
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Field 2.2' }), {
      target: { value: 'linear.title' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Value 2.2' }), {
      target: { value: 'keys' },
    });
    expect(await within(dialog).findByText('Matches 2 Items')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Rule' }));

    await screen.findByRole('dialog', { name: 'Re-file existing items' });
    expect(store.rules()[0]?.when).toEqual({
      join: 'and',
      terms: [
        { field: 'linear.team', op: 'is', value: 'team-eng', label: 'ENG' },
        {
          join: 'or',
          conditions: [
            { field: 'linear.label', op: 'is', value: 'label-bug', label: 'Bug' },
            { field: 'linear.title', op: 'contains', value: 'keys', label: 'keys' },
          ],
        },
      ],
    });
    expect(ruleRows()).toEqual([
      expect.stringContaining('team is ENG AND (label is Bug OR title contains “keys”)'),
    ]);
  });

  it('asks where a Rule goes when it overlaps another, and never decides silently', async () => {
    store.changeRule({
      type: 'create',
      rule: { target: { kind: 'project', projectId: tl.id }, when: teamIs('ENG', 'team-eng') },
    });
    renderSettings();
    const dialog = await openEditor();

    await choose(dialog, 'Files into', 'TX · Tactics');
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Field 1' }), {
      target: { value: 'linear.label' },
    });
    await choose(dialog, 'Value 1', 'Bug');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Rule' }));

    const place = await screen.findByRole('dialog', { name: 'Where does this Rule go?' });
    expect(store.rules()).toHaveLength(1);
    const choices = within(place).getByRole('radiogroup', { name: 'Where the Rule goes' });
    expect(
      within(choices)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['Above team is ENG → TL', 'Below team is ENG → TL']);
    fireEvent.click(within(choices).getByRole('radio', { name: 'Above team is ENG → TL' }));
    fireEvent.click(within(place).getByRole('button', { name: 'Save here' }));

    await waitFor(() => expect(store.rules().map((rule) => rule.target.projectId)).toEqual([tx.id, tl.id]));
  });

  it('reorders, edits and deletes Rules, and Undo brings a deleted one back', async () => {
    const make = (projectId: string, when: RuleWhen) =>
      store.changeRule({ type: 'create', rule: { target: { kind: 'project', projectId }, when } });
    make(tl.id, teamIs('ENG', 'team-eng'));
    make(tx.id, teamIs('OPS', 'team-ops'));
    renderSettings();
    await screen.findByRole('list', { name: 'Rules' });

    fireEvent.click(
      screen.getByRole('button', { name: 'Move team is OPS down' }).previousElementSibling as Element,
    );
    await waitFor(() => expect(ruleRows()[0]).toContain('team is OPS'));
    // The move puts OPS first, which re-files nothing: no Item matches both.
    expect(screen.queryByRole('dialog', { name: 'Re-file existing items' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit team is ENG' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Rule' });
    await choose(dialog, 'Files into', 'LT · Longtail');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Rule' }));
    await screen.findByRole('dialog', { name: 'Re-file existing items' });
    expect(store.rules()[1]?.target.projectId).toBe(lt.id);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

    fireEvent.click(screen.getByRole('button', { name: 'Delete team is OPS' }));
    await waitFor(() => expect(ruleRows()).toEqual([expect.stringContaining('team is ENG')]));
    const toast = (await screen.findByText(/Rule deleted: team is OPS → TX/)).closest('li') as HTMLElement;
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(ruleRows()).toHaveLength(2));
    expect(ruleRows()[0]).toContain('team is OPS');
  });
});
