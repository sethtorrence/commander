import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventDetail, Project } from '@commander/domain';
import {
  createGoogleCalendarSource,
  createOutlookCalendarSource,
  type SourceAdapter,
} from '@commander/sources';
import googleFirstSync from '@commander/sources/src/google-calendar/recorded/first-sync.json';
import firstSync from '@commander/sources/src/outlook-calendar/recorded/first-sync.json';
import quiet from '@commander/sources/src/outlook-calendar/recorded/quiet.json';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { calendarChoicesIn } from './index';

// Outlook Calendar's adapter saving into a real Item store, wired as the Core wires it (the store
// keeps the calendars and answers which are on), beside Google Calendar's: reading the same calendars
// again changes nothing, one calendar Rule files both Sources' events, and an event moved to another
// calendar keeps its Item, filing and Links.

type Exchange = {
  request: { path: string };
  response: { status: number; headers: Record<string, string>; body: unknown };
};

const GRAPH = 'https://graph.test/v1.0';
const GOOGLE_API = 'https://calendar.test/calendar/v3';
const NOW = Date.UTC(2026, 9, 3, 12);
const ACCOUNT = 'outlook:fake-tenant-0001:6f1c2a40-0000-4000-8000-00000000a001';
const GOOGLE_ACCOUNT = 'google:104512345678901234567';
const DEFAULT = 'AAMkAGI2-cal-default=';
const PROJECTS = 'AAMkAGI2-cal-titanlink=';

let dir: string;
let store: ItemStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-ocal-'));
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

// Answers each request with a recording made for that address.
function answering(base: string, exchanges: Exchange[]) {
  const queue = structuredClone(exchanges);
  return (async (url: string | URL | Request) => {
    const path = decodeURIComponent(String(url).slice(base.length));
    const index = queue.findIndex((each) => each.request.path === path);
    if (index < 0) throw new Error(`Unexpected request ${path}`);
    const [next] = queue.splice(index, 1) as [Exchange];
    return new Response(JSON.stringify(next.response.body), { status: next.response.status });
  }) as typeof globalThis.fetch;
}

const outlook = (exchanges: Exchange[]): SourceAdapter =>
  createOutlookCalendarSource({
    graphUrl: () => GRAPH,
    fetch: answering(GRAPH, exchanges),
    now: () => NOW,
    calendars: calendarChoicesIn(store, 'outlook-calendar'),
  });

async function sync(adapter: SourceAdapter, cursor: unknown = null, account = ACCOUNT) {
  const outcome = { created: 0, updated: 0, unchanged: 0, tombstoned: 0 };
  const result = await adapter.sync({
    account,
    cursor,
    mode: 'full',
    accessToken: async () => ({ token: 'eyJ0eXAiOi.test', kind: 'oauth' }),
    save: (page) => {
      const saved = store.saveFromSource({ source: adapter.source, account, ...page });
      outcome.created += saved.created.length;
      outcome.updated += saved.updated.length;
      outcome.unchanged += saved.unchanged.length;
      outcome.tombstoned += saved.tombstoned.length;
    },
    signal: new AbortController().signal,
  });
  return { ...outcome, cursor: result.cursor };
}

it('reading the same calendars in full again saves nothing and adds no activity', async () => {
  expect(await sync(outlook(firstSync as Exchange[]))).toMatchObject({ created: 5, updated: 0 });
  const activity = store.activity({ limit: 1000 });

  // A full re-read (as after an expired delta link) of the very same events.
  expect(await sync(outlook(firstSync as Exchange[]))).toMatchObject({
    created: 0,
    updated: 0,
    tombstoned: 0,
  });
  expect(store.activity({ limit: 1000 })).toEqual(activity);
  expect(store.calendars.list(ACCOUNT).map(({ name, source, on }) => [name, source, on])).toEqual([
    ['Calendar', 'outlook-calendar', true],
    ['Titanlink', 'outlook-calendar', true],
    ['United States holidays', 'outlook-calendar', false],
    ['Dana Ruiz', 'outlook-calendar', false],
  ]);
});

it('files Google and Outlook events by one calendar Rule as they arrive', async () => {
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
          { field: 'google-calendar.organiser', op: 'is', value: 'dana@titanlink.test', label: 'Dana Ruiz' },
        ],
      },
    },
  });
  await sync(outlook(firstSync as Exchange[]));
  await sync(
    createGoogleCalendarSource({
      apiUrl: () => GOOGLE_API,
      fetch: answering(GOOGLE_API, googleFirstSync as Exchange[]),
      now: () => NOW,
      calendars: calendarChoicesIn(store, 'google-calendar'),
    }),
    null,
    GOOGLE_ACCOUNT,
  );
  const filed = store
    .query({ kinds: ['event'] })
    .filter((item) => item.filing?.projectId === tl.id)
    .map((item) => [item.source, item.title]);
  expect(filed.sort()).toEqual([
    ['google-calendar', 'Design review: onboarding'],
    ['outlook-calendar', 'Design review: onboarding'],
  ]);
  // Both Accounts' events come back in one range, for the Agenda.
  const sources = new Set(
    store.events({ from: NOW, to: NOW + 30 * 24 * 60 * 60_000 }).map((item) => item.source),
  );
  expect(sources).toEqual(new Set(['google-calendar', 'outlook-calendar']));
});

it('keeps an event’s Item, filing and Links when it moves to another calendar', async () => {
  const { cursor } = await sync(outlook(firstSync as Exchange[]));
  const [dentist] = store.query({ kinds: ['event'], titleContains: 'Dentist' });
  const tl = store.changeProject({
    type: 'create',
    project: { name: 'Titanlink', code: 'TL', accent: 'blue' },
  }).project as Project;
  store.record(
    { type: 'update', itemId: dentist?.id ?? '', changes: { filing: { projectId: tl.id, filedBy: 'user' } } },
    { by: { kind: 'user' } },
  );
  const todo = store.record(
    { type: 'create', item: { kind: 'todo', title: 'Bring the form' } },
    { by: { kind: 'user' } },
  );
  store.link({ from: todo.itemId, linkType: 'about', to: dentist?.id ?? '' }, { by: { kind: 'user' } });

  const moved = structuredClone(quiet) as Exchange[];
  const original = (firstSync as Exchange[])[2]?.response.body as { value: { id: string }[] };
  (moved[2]?.response.body as { value: unknown[] }).value = [
    { id: dentist?.externalId, '@removed': { reason: 'deleted' } },
  ];
  (moved[3]?.response.body as { value: unknown[] }).value = [original.value[1]];
  await sync(outlook(moved), cursor);

  const after = store.get(dentist?.id ?? '');
  expect(after).toMatchObject({
    item: { filing: { projectId: tl.id, filedBy: 'user' }, deletedAt: null },
    backlinks: [{ type: 'about', from: { id: todo.itemId } }],
  });
  expect((after?.item.detail as EventDetail | undefined)?.calendar.id).toBe(PROJECTS);
  expect(
    store.calendarEvents({ source: 'outlook-calendar', account: ACCOUNT }, DEFAULT).map((e) => e.title),
  ).not.toContain('Dentist');
});
