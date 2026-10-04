import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, LinearIssueDetail, SearchQuery } from '@commander/domain';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';

// The search module through its interface (the Item store's `search`), against a real temporary
// database: the index follows every write the Item store makes, and queries rank and filter it.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const user: ActionContext = { by: { kind: 'user' } };
const ACME = 'linear:org-acme';
const GLOBEX = 'linear:org-globex';

let dir: string;
let store: ItemStore;
let clock: number;

const open = () =>
  openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-search-'));
  clock = Date.UTC(2026, 9, 1, 12);
  store = open();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const titles = (query: SearchQuery) => store.search.query(query).hits.map((hit) => hit.item.title);

function addTodo(title: string, projectId: string | null = null): string {
  const filing = projectId ? { projectId, filedBy: 'user' as const } : null;
  return store.record({ type: 'create', item: { kind: 'todo', title, filing } }, user).itemId;
}

function addBlock(day: string, text: string): string {
  const note = store.ensureDailyNote(day, user);
  return store.record(
    {
      type: 'create',
      item: {
        kind: 'block',
        title: text,
        detail: { kind: 'block', dailyNoteId: note.id, parentId: null, position: 'a0', text, folded: false },
      },
    },
    user,
  ).itemId;
}

function issue(
  identifier: string,
  title: string,
  extra: Partial<LinearIssueDetail> = {},
): { externalId: string; kind: 'linear-issue'; title: string; detail: LinearIssueDetail } {
  const [key] = identifier.split('-') as [string];
  return {
    externalId: `issue-${identifier}`,
    kind: 'linear-issue',
    title,
    detail: {
      kind: 'linear-issue',
      identifier,
      url: `https://linear.app/acme/issue/${identifier}`,
      team: { id: `team-${key}`, key, name: key },
      state: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#999999' },
      priority: 0,
      assignee: null,
      creator: null,
      labels: [],
      cycle: null,
      linearProject: null,
      dueDate: null,
      estimate: null,
      description: null,
      comments: [],
      createdAt: clock,
      updatedAt: clock,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      ...extra,
    },
  };
}

describe('indexing as the Item store writes', () => {
  it('finds an Item by its title as soon as it is saved', () => {
    addTodo('Renew the passport');
    expect(titles({ text: 'passport' })).toEqual(['Renew the passport']);
  });

  it('follows an update: the old words no longer find it, the new ones do', () => {
    const id = addTodo('Renew the passport');
    store.record({ type: 'update', itemId: id, changes: { title: 'Book the dentist' } }, user);
    expect(titles({ text: 'passport' })).toEqual([]);
    expect(titles({ text: 'dentist' })).toEqual(['Book the dentist']);
  });

  it('leaves out deleted Items and tombstones, and brings them back when undone', () => {
    const id = addTodo('Renew the passport');
    const deleted = store.record({ type: 'delete', itemId: id }, user);
    expect(titles({ text: 'passport' })).toEqual([]);
    store.record({ type: 'undo', entryId: deleted.id }, user);
    expect(titles({ text: 'passport' })).toEqual(['Renew the passport']);

    store.saveFromSource({
      source: 'linear',
      account: ACME,
      items: [issue('ENG-418', 'Fix the login loop')],
    });
    expect(titles({ text: 'login' })).toEqual(['Fix the login loop']);
    store.saveFromSource({ source: 'linear', account: ACME, deleted: ['issue-ENG-418'] });
    expect(titles({ text: 'login' })).toEqual([]);
  });

  it('leaves out Ares’s meeting preps: they are shown with their meeting, not found on their own', () => {
    store.record(
      {
        type: 'create',
        item: {
          kind: 'meeting-prep',
          title: 'Prep: Launch review',
          detail: {
            kind: 'meeting-prep',
            eventId: 'event-1',
            revision: 'r',
            preparedAt: clock,
            about: { text: 'The launch checklist', sources: ['event-1'] },
            lastTime: [],
            open: [],
            raise: [],
          },
        },
      },
      { by: { kind: 'ares' } },
    );
    expect(titles({ text: 'launch' })).toEqual([]);
  });

  it("indexes a Block's text, and says which day it belongs to", () => {
    const id = addBlock('2026-09-30', 'Call Priya about the rate limiter');
    const [hit] = store.search.query({ text: 'rate limiter' }).hits;
    expect(hit?.item.id).toBe(id);
    expect(hit?.day).toBe('2026-09-30');
    store.record(
      {
        type: 'update',
        itemId: id,
        changes: {
          detail: {
            kind: 'block',
            dailyNoteId: hit?.item.detail?.kind === 'block' ? hit.item.detail.dailyNoteId : '',
            parentId: null,
            position: 'a0',
            text: 'Call Sam about the invoices',
            folded: false,
          },
        },
      },
      user,
    );
    expect(titles({ text: 'limiter' })).toEqual([]);
    expect(titles({ text: 'invoices' })).toEqual(['Call Sam about the invoices']);
  });

  it("finds a Daily Note by its day's name", () => {
    store.ensureDailyNote('2026-09-30', user);
    const [hit] = store.search.query({ text: 'wednesday 30 september' }).hits;
    expect(hit?.item.kind).toBe('daily-note');
    expect(hit?.day).toBe('2026-09-30');
  });

  it("indexes a Linear issue's identifier, description and comments", () => {
    store.saveFromSource({
      source: 'linear',
      account: ACME,
      items: [
        issue('ENG-418', 'Fix the login loop', {
          description: 'The page **loops** after SSO on Safari.',
          comments: [
            {
              id: 'c1',
              author: null,
              body: 'Reproduced on staging with Okta.',
              createdAt: clock,
              updatedAt: clock,
            },
          ],
        }),
      ],
    });
    expect(titles({ text: 'safari' })).toEqual(['Fix the login loop']);
    expect(titles({ text: 'okta' })).toEqual(['Fix the login loop']);
    expect(titles({ text: 'ENG-418' })).toEqual(['Fix the login loop']);
  });

  it('indexes what was already in the database when the index is first built', () => {
    addTodo('Renew the passport');
    store.close();
    // An older database, from before search: the index is rebuilt from the Items when it opens.
    const raw = new Database(join(dir, 'commander.db'));
    raw.exec('DROP TABLE search_meta');
    raw.close();
    store = open();
    expect(titles({ text: 'passport' })).toEqual(['Renew the passport']);
  });
});

describe('matching', () => {
  it('matches the last word as a prefix while the User types', () => {
    addTodo('Renew the passport');
    expect(titles({ text: 'renew pass' })).toEqual(['Renew the passport']);
    // Only the last word: earlier words are whole.
    expect(titles({ text: 'ren passport' })).toEqual([]);
    // A space after the last word makes it whole too.
    expect(titles({ text: 'pass ' })).toEqual([]);
  });

  it('needs every word, ignores case, accents and punctuation', () => {
    addTodo('Café opening: book the band');
    addTodo('Book the dentist');
    expect(titles({ text: 'BOOK cafe' })).toEqual(['Café opening: book the band']);
    expect(titles({ text: '"book" (band)' })).toEqual(['Café opening: book the band']);
  });

  it('answers nothing for an empty query or one with no words', () => {
    addTodo('Renew the passport');
    expect(titles({ text: '' })).toEqual([]);
    expect(titles({ text: '  -- ' })).toEqual([]);
  });

  it('puts an exact identifier first, then an exact title, then the best matches', () => {
    store.saveFromSource({
      source: 'linear',
      account: ACME,
      items: [
        issue('ENG-4180', 'Mentions ENG 418 in passing'),
        issue('ENG-418', 'Fix the login loop'),
        issue('ENG-41', 'Something else', { description: 'See ENG-418 and ENG-418 again, ENG 418.' }),
      ],
    });
    const hits = store.search.query({ text: 'eng-418' }).hits;
    expect(hits[0]?.item.title).toBe('Fix the login loop');
    expect(hits[0]?.exact).toBe(true);
    expect(hits.slice(1).every((hit) => !hit.exact)).toBe(true);

    addTodo('Login loop notes for the login loop fix');
    addTodo('Login loop');
    const byTitle = store.search.query({ text: 'login loop' }).hits;
    expect(byTitle[0]?.item.title).toBe('Login loop');
    expect(byTitle[0]?.exact).toBe(true);
  });

  it('ranks a match in the title above one only in the body', () => {
    store.saveFromSource({
      source: 'linear',
      account: ACME,
      items: [
        issue('ENG-1', 'Tidy the docs', { description: 'Mentions the throttle once.' }),
        issue('ENG-2', 'Throttle bursts on sync'),
      ],
    });
    expect(titles({ text: 'throttle' })).toEqual(['Throttle bursts on sync', 'Tidy the docs']);
  });

  it('says every hit was found by its words', () => {
    addTodo('Renew the passport');
    expect(store.search.query({ text: 'passport' }).hits[0]?.foundBy).toEqual(['words']);
  });

  it('keeps to the limit', () => {
    for (let i = 0; i < 30; i++) addTodo(`Passport form ${i}`);
    expect(titles({ text: 'passport', limit: 5 })).toHaveLength(5);
    expect(titles({ text: 'passport' })).toHaveLength(30);
  });
});

describe('filters', () => {
  let longtail: string;
  let titanlink: string;

  beforeEach(() => {
    longtail = store.changeProject({
      type: 'create',
      project: { name: 'Longtail', code: 'LT', accent: 'blue' },
    }).project?.id as string;
    titanlink = store.changeProject({
      type: 'create',
      project: { name: 'Titanlink', code: 'TL', accent: 'green' },
    }).project?.id as string;
    addTodo('Invoice Longtail', longtail);
    addTodo('Invoice Titanlink', titanlink);
    addTodo('Invoice nobody');
    addBlock('2026-09-29', 'Invoice reminder in the notes');
    store.saveFromSource({
      source: 'linear',
      account: ACME,
      items: [issue('ENG-1', 'Invoice export (Acme)')],
    });
    store.saveFromSource({
      source: 'linear',
      account: GLOBEX,
      items: [issue('OPS-1', 'Invoice export (Globex)')],
    });
  });

  it('by Project, or Unfiled', () => {
    expect(titles({ text: 'invoice', projectId: longtail })).toEqual(['Invoice Longtail']);
    expect(titles({ text: 'invoice', projectId: null }).sort()).toEqual([
      'Invoice export (Acme)',
      'Invoice export (Globex)',
      'Invoice nobody',
      'Invoice reminder in the notes',
    ]);
  });

  it('follows filing: an Item moved to another Project is found under it', () => {
    const [nobody] = store.search.query({ text: 'nobody' }).hits;
    store.record(
      {
        type: 'update',
        itemId: nobody?.item.id as string,
        changes: { filing: { projectId: titanlink, filedBy: 'user' } },
      },
      user,
    );
    expect(titles({ text: 'invoice', projectId: titanlink }).sort()).toEqual([
      'Invoice Titanlink',
      'Invoice nobody',
    ]);
  });

  it('by kind (a Section)', () => {
    expect(titles({ text: 'invoice', kinds: ['block', 'daily-note'] })).toEqual([
      'Invoice reminder in the notes',
    ]);
    expect(titles({ text: 'invoice', kinds: ['todo'] })).toHaveLength(3);
  });

  it('by Account', () => {
    expect(titles({ text: 'invoice', accounts: [GLOBEX] })).toEqual(['Invoice export (Globex)']);
    expect(titles({ text: 'invoice', accounts: [ACME, GLOBEX] })).toHaveLength(2);
  });

  it('by date last changed', () => {
    clock = Date.UTC(2026, 9, 5, 12);
    addTodo('Invoice later');
    expect(titles({ text: 'invoice', from: Date.UTC(2026, 9, 5) })).toEqual(['Invoice later']);
    expect(titles({ text: 'invoice', to: Date.UTC(2026, 9, 5) })).toHaveLength(6);
    expect(titles({ text: 'invoice', from: Date.UTC(2026, 9, 2), to: Date.UTC(2026, 9, 4) })).toEqual([]);
  });

  it('finds Projects by name or code, unless a filter narrows the search to Items', () => {
    const names = (query: SearchQuery) => store.search.query(query).projects.map((project) => project.name);
    expect(names({ text: 'long' })).toEqual(['Longtail']);
    expect(names({ text: 'tl' })).toEqual(['Titanlink']);
    expect(names({ text: 'invoice' })).toEqual([]);
    expect(names({ text: 'long', kinds: ['todo'] })).toEqual([]);
    store.changeProject({ type: 'archive', projectId: longtail });
    expect(names({ text: 'long' })).toEqual([]);
  });
});
