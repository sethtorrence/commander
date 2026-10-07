import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { type ActionContext, attachmentMarkdown, type ExportStep } from '@commander/domain';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { integrityProblem } from '../item-store/snapshots';
import { EXPORT_README, ExportCancelled, exportEverything } from './export';

// Export everything (#202): the database, the Daily Notes as Markdown, pasted images and cached
// attachments, with a README, in a folder of its own inside the one chosen. Never a secret.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const user: ActionContext = { by: { kind: 'user' } };
// What the User's sign-ins and keys look like in the data folder, which the export must never carry.
const SECRET = 'ghp_SECRETtoken0123456789abcdefABCDEF';

let root: string;
let dataDir: string;
let chosen: string;
let store: ItemStore;
// Local noon, so the export's folder is named the same in every time zone.
const clock = new Date(2026, 9, 6, 12).getTime();
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'commander-export-'));
  dataDir = join(root, 'userData');
  chosen = join(root, 'Backups');
  mkdirSync(dataDir);
  mkdirSync(chosen);
  writeFileSync(join(chosen, 'my own file.txt'), 'mine');
  store = openItemStore({
    path: join(dataDir, 'commander.db'),
    snapshotDir: join(dataDir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });

  // Everything Commander keeps in its data folder, the User's data and their secrets alike.
  store.saveFromSource({
    source: 'gmail',
    account: 'work@example.com',
    items: [{ externalId: 'm1', kind: 'email', title: 'Quarterly numbers' }],
  });
  const note = store.ensureDailyNote('2026-10-06', user);
  const { name } = store.saveAttachment(png);
  const block = (text: string, position: string) =>
    store.record(
      {
        type: 'create',
        item: {
          id: randomUUID(),
          kind: 'block',
          title: text,
          detail: { kind: 'block', dailyNoteId: note.id, parentId: null, position, text, folded: false },
        },
      },
      user,
    );
  block('Stand-up with **Ana**', 'a0');
  block(attachmentMarkdown(name), 'a1');
  mkdirSync(join(dataDir, 'email-parts', 'a1b2c3', '0.2'), { recursive: true });
  writeFileSync(join(dataDir, 'email-parts', 'a1b2c3', '0.2', 'budget.pdf'), '%PDF budget');
  mkdirSync(join(dataDir, 'compose-files'));
  writeFileSync(join(dataDir, 'compose-files', 'draft-1'), 'an attachment waiting to be sent');
  writeFileSync(join(dataDir, 'secrets.json'), JSON.stringify({ github: SECRET }));
  writeFileSync(join(dataDir, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: SECRET } }));
  writeFileSync(join(dataDir, 'Cookies'), SECRET);
  mkdirSync(join(dataDir, 'models'));
  writeFileSync(join(dataDir, 'models', 'model.onnx'), 'weights');
  writeFileSync(join(dataDir, 'restore-pending.json'), '{}');
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/** Every file under a folder, as relative paths. */
function filesIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => statSync(join(dir, path)).isFile())
    .map((path) => relative(dir, join(dir, path)))
    .sort();
}

function run(signal = new AbortController().signal, steps: [ExportStep, number, number][] = []) {
  return exportEverything({
    store,
    dataDir,
    attachmentsDir: join(dataDir, 'attachments'),
    into: chosen,
    signal,
    now: () => clock,
    onProgress: (step, done, total) => steps.push([step, done, total]),
  });
}

describe('Export everything', () => {
  it('writes the database, the Daily Notes, images, attachments and a README into a folder of its own', async () => {
    const steps: [ExportStep, number, number][] = [];
    const folder = await run(undefined, steps);

    expect(folder).toBe(join(chosen, 'Commander export 2026-10-06 12.00'));
    expect(readdirSync(chosen).sort()).toEqual(['Commander export 2026-10-06 12.00', 'my own file.txt']);
    const image = readdirSync(join(dataDir, 'attachments'))[0] as string;
    expect(filesIn(folder)).toEqual(
      [
        'README.txt',
        'commander.db',
        'Daily Notes/2026-10-06.md',
        `Daily Notes/attachments/${image}`,
        `attachments/${image}`,
        'compose-files/draft-1',
        'email-parts/a1b2c3/0.2/budget.pdf',
      ].sort(),
    );

    // A consistent, checked copy of the database, with every Item.
    expect(integrityProblem(join(folder, 'commander.db'))).toBeNull();
    const copy = new Database(join(folder, 'commander.db'), { readonly: true });
    expect(copy.prepare("SELECT title FROM items WHERE kind = 'email'").pluck().all()).toEqual([
      'Quarterly numbers',
    ]);
    copy.close();
    expect(readFileSync(join(folder, 'Daily Notes/2026-10-06.md'), 'utf8')).toContain(
      'Stand-up with **Ana**',
    );
    expect(new Uint8Array(readFileSync(join(folder, 'attachments', image)))).toEqual(png);
    expect(readFileSync(join(folder, 'email-parts/a1b2c3/0.2/budget.pdf'), 'utf8')).toBe('%PDF budget');
    expect(readFileSync(join(folder, 'README.txt'), 'utf8')).toBe(EXPORT_README);

    // Its progress, step by step.
    expect(steps).toEqual([
      ['database', 0, 1],
      ['database', 1, 1],
      ['daily-notes', 0, 1],
      ['daily-notes', 1, 1],
      ['images', 0, 1],
      ['images', 1, 1],
      ['attachments', 0, 2],
      ['attachments', 1, 2],
      ['attachments', 2, 2],
      ['readme', 0, 1],
      ['readme', 1, 1],
    ]);
  });

  it('never carries a secret, token or key, by name or by content', async () => {
    const folder = await run();
    const files = filesIn(folder);
    for (const name of ['secrets.json', 'Local State', 'Cookies', 'model.onnx', 'restore-pending.json'])
      expect(files.some((path) => path.endsWith(name))).toBe(false);
    for (const path of files) expect(readFileSync(join(folder, path)).includes(SECRET)).toBe(false);
  });

  it('can be cancelled, leaving nothing behind but what was there', async () => {
    const abort = new AbortController();
    const steps: [ExportStep, number, number][] = [];
    const exporting = exportEverything({
      store,
      dataDir,
      attachmentsDir: join(dataDir, 'attachments'),
      into: chosen,
      signal: abort.signal,
      now: () => clock,
      onProgress: (step, done, total) => {
        steps.push([step, done, total]);
        if (step === 'images') abort.abort();
      },
    });
    await expect(exporting).rejects.toThrow(ExportCancelled);
    expect(readdirSync(chosen)).toEqual(['my own file.txt']);
    expect(steps.at(-1)?.[0]).toBe('images');
  });

  it('never writes over an earlier export', async () => {
    const first = await run();
    const second = await run();
    expect(second).toBe(`${first} (2)`);
    expect(readdirSync(chosen).sort()).toEqual([
      'Commander export 2026-10-06 12.00',
      'Commander export 2026-10-06 12.00 (2)',
      'my own file.txt',
    ]);
  });
});
