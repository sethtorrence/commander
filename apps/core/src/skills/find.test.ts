import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, FindInput, Project } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowCloudMail, deliver } from '../agent/fixtures/emails';
import {
  attendee,
  DANA,
  eventItem,
  ME,
  PRIYA,
  syncEvents,
  syncIssues,
  writeBlock,
} from '../agent/testing/meeting-fixtures';
import { type ItemStore, openItemStore } from '../item-store';
import { createFindSkill, meaningfulWords, personNamed, projectNamed } from './find';
import { rangeOf } from './findings';

// Find (#192): what Ares looks up for a Conversation, over a real Item store, its clock pinned to a
// Tuesday morning (in whatever time zone the tests run in).

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const NOW = new Date(2026, 9, 6, 9, 0).getTime();
const HOUR = 3_600_000;
const user: ActionContext = { by: { kind: 'user' } };

let dir: string;
let store: ItemStore;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  dir = mkdtempSync(join(tmpdir(), 'commander-find-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

const find = (input: FindInput) => createFindSkill({ itemStore: store, now: () => NOW }).run(input);
const titles = (found: Awaited<ReturnType<typeof find>>) => found.items.map(({ item }) => item.title);

function project(name: string, code: string): Project {
  return store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project as Project;
}

function file(itemId: string, projectId: string) {
  store.record({ type: 'update', itemId, changes: { filing: { projectId, filedBy: 'user' } } }, user);
}

describe('Find', () => {
  it('finds Items by their words, and reads each: an email by its text, a Daily Note line by what the User wrote', async () => {
    allowCloudMail(store);
    deliver(store, NOW, [
      { id: 'redlines', subject: 'Contract', text: 'Leo marked up the Acme redlines, clause 4.' },
    ]);
    writeBlock(store, '2026-10-05', 'Chase Leo about the Acme redlines');
    writeBlock(store, '2026-10-05', 'Lunch with Sam');

    const found = await find({ query: 'acme redlines' });

    expect(titles(found).sort()).toEqual(['Chase Leo about the Acme redlines', 'Contract']);
    const email = found.items.find(({ item }) => item.kind === 'email');
    expect(email?.text).toContain('From: Dana Whitfield <dana@northwind.test>');
    expect(email?.text).toContain('Leo marked up the Acme redlines, clause 4.');
    expect(found.note).toBe('Find looked for the words “acme redlines”: 2 Items.');
  });

  it('looks for each word on its own when every word together finds little', async () => {
    writeBlock(store, '2026-10-05', 'Acme kickoff on Thursday');
    writeBlock(store, '2026-10-05', 'Clause 4 needs a lawyer');
    const found = await find({ query: 'acme clause email' });
    expect(titles(found).sort()).toEqual(['Acme kickoff on Thursday', 'Clause 4 needs a lawyer']);
    expect(meaningfulWords('Find the email about the Acme redlines')).toEqual(['acme', 'redlines']);
  });

  it('never reads a Gmail Account’s mail before the User allowed it', async () => {
    deliver(store, NOW, [{ id: 'redlines', subject: 'Acme redlines', text: 'Private.' }]);
    expect((await find({ query: 'acme redlines' })).items).toEqual([]);
    allowCloudMail(store);
    expect(titles(await find({ query: 'acme redlines' }))).toEqual(['Acme redlines']);
  });

  it('answers “what’s on today?”: today’s events in order, the Todos due, and today’s Daily Note', async () => {
    syncEvents(store, [
      eventItem('late', 'Design review', NOW + 5 * HOUR),
      eventItem('early', 'Standup', NOW + HOUR),
      eventItem('tomorrow', 'Planning', NOW + 26 * HOUR),
    ]);
    store.record(
      {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'Pay the invoice',
          detail: { kind: 'todo', origin: 'manual', dueOn: '2026-10-06', backedBy: null },
        },
      },
      user,
    );
    store.record(
      {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'File taxes',
          detail: { kind: 'todo', origin: 'manual', dueOn: '2026-10-20', backedBy: null },
        },
      },
      user,
    );
    writeBlock(store, '2026-10-06', 'Ship the beta');
    writeBlock(store, '2026-10-04', 'Sunday chores');

    const found = await find({ when: 'today' });

    expect(titles(found)).toEqual(['Standup', 'Design review', 'Pay the invoice', 'Ship the beta']);
    expect(found.items[0]?.text).toMatch(/When: 2026-10-06 10:00 to 10:30/);
    expect(found.note).toBe('Find looked for today: 4 Items.');
  });

  it('narrows to a person, by every handle of theirs, and to a time', async () => {
    syncEvents(store, [
      eventItem('one', 'Priya 1:1', NOW + HOUR, {
        attendees: [attendee(ME, { organiser: true }), attendee(PRIYA)],
      }),
      eventItem('two', 'Dana sync', NOW + 2 * HOUR, {
        attendees: [attendee(ME, { organiser: true }), attendee(DANA)],
      }),
    ]);
    syncIssues(store, [
      { id: 'a', title: 'Ship the rate limiter', people: [PRIYA], status: 'done' },
      { id: 'b', title: 'Fix the login page', people: [DANA] },
    ]);
    expect(personNamed(store.people.list(), 'priya')?.name).toBe('Priya Patel');

    const found = await find({ person: 'Priya', when: 'this-week' });

    expect(titles(found).sort()).toEqual(['Priya 1:1', 'Ship the rate limiter']);
    expect(found.note).toBe('Find looked for Items involving the person “Priya”, this week: 2 Items.');
  });

  it('narrows to a Project, and looks for one it doesn’t know as words', async () => {
    const titanlink = project('Titanlink', 'TL');
    const filed = writeBlock(store, '2026-10-05', 'Titanlink: pricing page');
    file(filed, titanlink.id);
    writeBlock(store, '2026-10-05', 'Longtail: pricing page');

    expect(titles(await find({ project: 'TL', query: 'pricing' }))).toEqual(['Titanlink: pricing page']);
    expect(projectNamed(store.projects(), 'titan')?.code).toBe('TL');
    const unknown = await find({ project: 'Longtail' });
    expect(titles(unknown)).toEqual(['Longtail: pricing page']);
    expect(unknown.note).toMatch(/No Project is called “Longtail”, so it was looked for as words/);
  });

  it('brings what Ares knows, as the User’s when they confirmed it, and the past Updates about it as background', async () => {
    store.memory.learn({
      kind: 'fact',
      text: 'Leo is our Acme contact',
      confirmed: true,
      by: 'user',
      sources: [],
    });
    const block = writeBlock(store, '2026-10-05', 'Acme kickoff');
    store.updates.saveUpdate({
      at: NOW - 2 * HOUR,
      awayMs: 0,
      folded: false,
      voice: 'template',
      lines: [
        {
          queuedId: 1,
          group: 'fyi',
          kind: 'suggestions',
          text: 'Leo replied about the Acme kickoff.',
          itemIds: [block],
          section: 'notes',
          sources: [],
          folded: false,
          fresh: true,
        },
      ],
    });

    const found = await find({ query: 'acme' });

    const knows = found.more.find((part) => part.label === 'What Ares knows');
    expect(knows?.from).toBe('user-settings');
    expect(knows?.text).toContain('Leo is our Acme contact');
    const past = found.more.find((part) => part.label.startsWith('Past Update, 2026-10-06 07:00'));
    expect(past?.text).toBe('Leo replied about the Acme kickoff.');
    expect(past?.from).toEqual({ background: [expect.objectContaining({ id: block })] });
  });

  it('says plainly when nothing matches', async () => {
    const found = await find({ query: 'zeppelin' });
    expect(found.items).toEqual([]);
    expect(found.note).toBe('Find looked for the words “zeppelin”: nothing in Commander matches.');
  });
});

describe('the times Find understands', () => {
  it('are days and Monday-to-Sunday weeks on the User’s own calendar', () => {
    const at = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
    expect(rangeOf('today', NOW)).toMatchObject({ from: at(2026, 10, 6), to: at(2026, 10, 7) });
    expect(rangeOf('yesterday', NOW)).toMatchObject({ from: at(2026, 10, 5), to: at(2026, 10, 6) });
    expect(rangeOf('this-week', NOW)).toMatchObject({ from: at(2026, 10, 5), to: at(2026, 10, 12) });
    expect(rangeOf('last-week', NOW)).toMatchObject({ from: at(2026, 9, 28), to: at(2026, 10, 5) });
    expect(rangeOf('this-month', NOW)).toMatchObject({ from: at(2026, 10, 1), to: at(2026, 11, 1) });
    // Just after midnight on a Sunday, the week is still the one that began on Monday.
    const sunday = new Date(2026, 9, 11, 0, 5).getTime();
    expect(rangeOf('this-week', sunday)).toMatchObject({ from: at(2026, 10, 5), to: at(2026, 10, 12) });
    expect(rangeOf('today', sunday)).toMatchObject({ from: at(2026, 10, 11), to: at(2026, 10, 12) });
  });
});
