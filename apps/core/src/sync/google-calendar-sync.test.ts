import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '@commander/domain';
import { createGoogleCalendarSource, type SourceAdapter } from '@commander/sources';
import firstSync from '@commander/sources/src/google-calendar/recorded/first-sync.json';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';

// Google Calendar's adapter saving into a real Item store, wired as the Core wires it (the store
// keeps the calendars and answers which are on): syncing the same calendars again changes nothing
// and logs nothing, and filing, Rules and Links survive.

type Exchange = {
  request: { path: string };
  response: { status: number; headers: Record<string, string>; body: unknown };
};

const API = 'https://calendar.test/calendar/v3';
const NOW = Date.UTC(2026, 9, 3, 12);
const ACCOUNT = 'google:104512345678901234567';
const STANDUPS = 'c_tl_standups@group.calendar.google.com';

let dir: string;
let store: ItemStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-gcal-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => NOW,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function adapter(exchanges: Exchange[]): SourceAdapter {
  const queue = [...exchanges];
  const fetch = (async (url: string | URL | Request) => {
    const next = queue.shift();
    const path = decodeURIComponent(String(url).slice(API.length));
    if (next?.request.path !== path) throw new Error(`Unexpected request ${path}`);
    return new Response(JSON.stringify(next.response.body), { status: next.response.status });
  }) as typeof globalThis.fetch;
  return createGoogleCalendarSource({
    apiUrl: () => API,
    fetch,
    now: () => NOW,
    calendars: {
      listed: (account, calendars) => store.calendars.listed(account, 'google-calendar', calendars),
      held: (account, calendarId) =>
        store.calendarEvents({ source: 'google-calendar', account }, calendarId).map((item) => ({
          externalId: item.externalId ?? '',
          title: item.title,
          people: item.people,
          status: item.status,
          detail: item.detail,
        })),
    },
  });
}

async function sync(cursor: unknown = null) {
  const outcome = { created: 0, updated: 0, unchanged: 0, tombstoned: 0 };
  const result = await adapter(firstSync as Exchange[]).sync({
    account: ACCOUNT,
    cursor,
    mode: 'full',
    accessToken: async () => ({ token: 'ya29.test', kind: 'oauth' }),
    save: (page) => {
      const saved = store.saveFromSource({ source: 'google-calendar', account: ACCOUNT, ...page });
      outcome.created += saved.created.length;
      outcome.updated += saved.updated.length;
      outcome.unchanged += saved.unchanged.length;
      outcome.tombstoned += saved.tombstoned.length;
    },
    signal: new AbortController().signal,
  });
  return { ...outcome, cursor: result.cursor };
}

it('reading the same calendars again leaves every event unchanged and adds no activity', async () => {
  expect(await sync()).toMatchObject({ created: 6, updated: 0 });
  const activity = store.activity({ limit: 1000 });

  // A full re-read (as after a 410) of the very same events.
  expect(await sync()).toMatchObject({ created: 0, updated: 0, tombstoned: 0, unchanged: 6 });
  expect(store.activity({ limit: 1000 })).toEqual(activity);
});

it('files events by a calendar Rule as they arrive, and keeps filing and Links through later syncs', async () => {
  const tl = store.changeProject({
    type: 'create',
    project: { name: 'Titanlink', code: 'TL', accent: 'blue' },
  }).project as Project;
  store.changeRule({
    type: 'create',
    rule: {
      target: { kind: 'project', projectId: tl.id },
      when: {
        join: 'and',
        terms: [
          { field: 'google-calendar.calendar', op: 'is', value: STANDUPS, label: 'Titanlink Standups' },
        ],
      },
    },
  });
  await sync();
  const filed = store
    .query({ kinds: ['event'] })
    .filter((item) => item.filing)
    .map((item) => item.title);
  expect(filed).toEqual(['TL standup', 'TL standup']);

  const [dentist] = store.query({ kinds: ['event'], titleContains: 'Dentist' });
  store.record(
    { type: 'update', itemId: dentist?.id ?? '', changes: { filing: { projectId: tl.id, filedBy: 'user' } } },
    { by: { kind: 'user' } },
  );
  const todo = store.record(
    { type: 'create', item: { kind: 'todo', title: 'Bring the form' } },
    { by: { kind: 'user' } },
  );
  store.link({ from: todo.itemId, linkType: 'about', to: dentist?.id ?? '' }, { by: { kind: 'user' } });

  await sync();
  expect(store.get(dentist?.id ?? '')).toMatchObject({
    item: { filing: { projectId: tl.id, filedBy: 'user' }, deletedAt: null },
    backlinks: [{ type: 'about', from: { id: todo.itemId } }],
  });
  expect(store.calendars.list().map(({ name, on }) => [name, on])).toEqual([
    ['alex@gmail.test', true],
    ['Titanlink Standups', true],
    ['Holidays in United Kingdom', false],
  ]);
});
