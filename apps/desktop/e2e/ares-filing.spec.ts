import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
} from '@commander/models/testing';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { ACME, type FakeLinear, startFakeLinear } from '../src/main/linear/fake-linear-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Ares files Items into Projects, end to end: a fake Linear (never the real one) and a fake
// OpenAI-compatible server standing in for Z.ai. A sync brings issues no Rule files; Ares files the
// one he is sure of (a solid Badge, "Filed under TL by Ares") and leaves his dashed Badge on the
// others. The User changes them, one after another, to the same Project; Ares then asks in the
// Update whether to make it a Rule; accepting opens the Rule, filled in, which goes at the top and
// re-files the issue still waiting. His activity page keeps the score. The model's key and the
// Linear key go in the real keyring, so this needs the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const API_KEY = 'lin_api_e2e_ares_filing_key';
const OPS = { id: 'team-ops', key: 'OPS', name: 'Operations' };
const PAGER = ['Pager rota for October', 'Rotate the on-call phone', 'Runbook for the backup job'];
const MORE = ['Status page wording', 'Renew the TLS certificate', 'Pager rota for November'];

// The fake model: "File into Projects" is sure the Relay issue is Titanlink's, and guesses (wrongly,
// and unsure) that the OPS issues are too. Any other job gets nothing to do; the Update keeps its
// plain sentences.
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as { role: string; content: string }[];
  const system = messages[0]?.content ?? '';
  const prompt = messages.at(-1)?.content ?? '';
  if (system.includes('You file the User')) {
    const [, ref, title] = /label="(I\d+) · Linear issue [^"]*"[^>]*>\n┆ Title: (.*)/.exec(prompt) ?? [];
    const sure = title?.includes('Relay');
    const filings = ref
      ? [
          {
            itemId: ref,
            projectCode: 'TL',
            confidence: sure ? 0.95 : 0.55,
            reason: sure ? 'Relay is a Titanlink project' : 'Looks like Titanlink work',
          },
        ]
      : [];
    return { json: chatCompletion(JSON.stringify({ filings, steering: [] })) };
  }
  if (system.includes("rank the User's Dashboard")) return { json: chatCompletion('{"ranking":[]}') };
  if (system.includes('their Update')) return { json: chatCompletion('{"lines":[]}') };
  return { json: chatCompletion('{"todos":[]}') };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Points Ares's model at the fake server and saves a made-up key in the keyring.
async function connectFakeModel(window: Page, server: FakeOpenAIServer) {
  const ares = window.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
  await window.getByTestId('model-key-input').fill('zai-e2e-ares-filing-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

async function createProject(window: Page, name: string, code: string) {
  const form = window.getByRole('form', { name: 'New Project' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Badge code').fill(code);
  await form.getByRole('button', { name: 'Create Project' }).click();
  await expect(window.getByRole('list', { name: 'Projects' })).toContainText(`${code}${name}`);
}

const row = (section: Locator, title: string) =>
  section.getByTestId('linear-issue').filter({ hasText: title });

let linear: FakeLinear;
let server: FakeOpenAIServer;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  server = await startFakeOpenAIServer();
  server.respondWith(model);
  linear = await startFakeLinear();
  linear.addApiKey(API_KEY, ACME);
  linear.issues.add(ACME.id, { identifier: 'ENG-1', title: 'Relay latency dashboard' });
  [...PAGER, ...MORE].forEach((title, i) => {
    linear.issues.add(ACME.id, { identifier: `OPS-${i + 1}`, title, team: OPS });
  });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await linear?.close();
  await server?.close();
});

test('new issues → dashed Badge → Change, again and again → a Rule suggested in the Update → accepted', async () => {
  test.setTimeout(120_000);
  commander = await launchCommander({
    env: {
      COMMANDER_TEST_LINEAR: JSON.stringify({
        clientId: null,
        port: await freePort(),
        authorizeUrl: linear.authorizeUrl,
        tokenUrl: linear.tokenUrl,
        apiUrl: linear.apiUrl,
      }),
    },
  });
  const window = await commander.app.firstWindow();
  await openSettings(window);
  await connectFakeModel(window, server);
  await createProject(window, 'Titanlink', 'TL');
  await createProject(window, 'Tactics', 'TX');

  // Connect Linear: the sync brings seven issues no Rule files, and Ares files them as they arrive.
  const accounts = window.getByTestId('accounts-panel');
  await accounts.getByLabel('Linear personal API key').fill(API_KEY);
  await accounts.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(accounts.getByTestId('account-synced')).toHaveText(/7 issues/);
  await window.keyboard.press('Escape');
  await tab(window, 'Linear').click();
  const section = window.getByTestId('section-linear');
  await section.getByRole('tab', { name: /All tickets/ }).click();

  // Sure: a solid Badge, and "Filed under TL by Ares" with his reason in the issue's log.
  const relay = row(section, 'Relay latency dashboard');
  await expect(relay.getByRole('img', { name: 'Titanlink', exact: true })).toBeVisible({ timeout: 20_000 });
  // Not sure: the dashed Badge on each OPS issue.
  for (const title of [...PAGER, ...MORE]) {
    await expect(row(section, title).getByRole('img', { name: 'Ares suggests Titanlink' })).toBeVisible({
      timeout: 20_000,
    });
  }
  await relay.click();
  const detail = section.getByRole('region', { name: 'Issue detail' });
  await expect(detail.getByRole('region', { name: 'Activity' }).getByRole('listitem').first()).toContainText(
    'Filed under TL by Ares',
  );

  // The first, from its detail pane: Confirm and Change beside the dashed Badge; Change opens the
  // picker, and choosing Tactics files it by the User.
  await row(section, PAGER[0] as string).click();
  const suggested = detail.getByTestId('suggested-filing');
  await expect(suggested.getByRole('img', { name: 'Ares suggests Titanlink' })).toBeVisible();
  await expect(suggested.getByRole('button', { name: 'Confirm Titanlink' })).toBeVisible();
  await suggested.getByRole('button', { name: 'Change the Project' }).click();
  const picker = window.getByTestId('badge-picker');
  await expect(picker.getByTestId('badge-picker-suggestion')).toContainText('Ares suggests Titanlink');
  await window.keyboard.type('TX');
  await window.keyboard.press('Enter');
  await expect(row(section, PAGER[0] as string).getByRole('img', { name: 'Tactics' })).toBeVisible();
  await expect(detail.getByRole('region', { name: 'Activity' })).toContainText('Corrected Ares: TL → TX');

  // Then four more from their rows: a click on the dashed Badge opens the picker with Confirm on top.
  for (const title of [...PAGER.slice(1), ...MORE.slice(0, 2)]) {
    await row(section, title)
      .getByRole('button', { name: /^Project of / })
      .click();
    await expect(picker.getByTestId('badge-picker-suggestion')).toBeVisible();
    await window.keyboard.type('TX');
    await window.keyboard.press('Enter');
    await expect(row(section, title).getByRole('img', { name: 'Tactics' })).toBeVisible();
  }
  // The sixth still waits.
  const waiting = row(section, MORE[2] as string);
  await expect(waiting.getByRole('img', { name: 'Ares suggests Titanlink' })).toBeVisible();

  // Five corrections the same way: the Update asks to make it a Rule.
  await window.keyboard.press('Escape');
  await window.keyboard.press('u');
  const update = window.getByTestId('update-panel');
  const offer = update
    .getByTestId('update-line')
    .filter({ hasText: 'Always file Linear team OPS under TX?' });
  await expect(offer).toContainText('You filed 5 Linear issues from team OPS under TX.');
  await offer.getByRole('button', { name: 'Make the Rule…' }).click();

  // The Rule, filled in: team is OPS → Tactics. Saved, it goes at the top, and offers to re-file the
  // issue still waiting on Ares's suggestion (hand-filed ones are never re-filed).
  const editor = window.getByRole('dialog', { name: 'New Rule' });
  await expect(editor.getByRole('combobox', { name: 'Files into' })).toHaveValue(/.+/);
  await expect(editor.getByRole('combobox', { name: 'Files into' }).locator('option:checked')).toHaveText(
    'TX · Tactics',
  );
  await expect(editor.getByRole('combobox', { name: 'Value 1' }).locator('option:checked')).toHaveText('OPS');
  await editor.getByRole('button', { name: 'Save Rule' }).click();
  const refile = window.getByRole('dialog', { name: 'Re-file existing items' });
  await expect(refile).toContainText('Also re-file 1 existing item?');
  await expect(refile.getByRole('list', { name: 'Re-file preview' })).toContainText(MORE[2] as string);
  await refile.getByRole('button', { name: 'Re-file 1 item' }).click();
  await expect(waiting.getByRole('img', { name: 'Tactics' })).toBeVisible();

  // The Rule is first in Settings → Rules, and the suggestion is settled.
  await openSettings(window);
  await expect(window.getByRole('list', { name: 'Rules' }).getByRole('listitem').first()).toContainText(
    'team is OPS',
  );
  await window.keyboard.press('Escape');

  // Ares's activity page keeps the score: one filed on his own, six suggested, five corrected.
  await tab(window, 'Ares').click();
  const record = window.getByTestId('filing-record');
  await expect(record.getByTestId('filing-record-filed')).toHaveText('1');
  await expect(record.getByTestId('filing-record-suggested')).toHaveText('6');
  await expect(record.getByTestId('filing-record-confirmed')).toHaveText('0');
  await expect(record.getByTestId('filing-record-corrected')).toHaveText('5');
});
