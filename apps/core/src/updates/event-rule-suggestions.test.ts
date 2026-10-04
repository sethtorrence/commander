import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActionContext, type EventDetail, type Project, ruleSuggestionDraft } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { templateText } from './compose';
import { createUpdateQueue, type UpdateQueue } from './queue';
import { createRuleSuggestions } from './rule-suggestions';

// "Suggest rules" for calendar events (#127): five consistent answers to Ares's filing of events on
// one calendar queue "Always file events in calendar Titanlink Standups under TL?", as they do for
// Linear teams. On a real database, with the answers recorded as the Item store records them.

const user: ActionContext = { by: { kind: 'user' } };
const SAM = 'outlook:tenant:sam';
const STANDUPS = { id: 'AAMk-standups=', name: 'Titanlink Standups', colour: '#33b679' };

let dir: string;
let store: ItemStore;
let queue: UpdateQueue;
let suggestions: ReturnType<typeof createRuleSuggestions>;
let lt: Project;
let tl: Project;
let next = 1;

function project(name: string, code: string): Project {
  return store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project as Project;
}

function event(calendar = STANDUPS): string {
  const id = String(next++);
  const start = Date.UTC(2026, 9, 5 + next, 9);
  const detail: EventDetail = {
    kind: 'event',
    calendar,
    accountEmail: 'sam@contoso.test',
    start: { at: start, timeZone: 'Europe/London', date: null },
    end: { at: start + 15 * 60_000, timeZone: 'Europe/London', date: null },
    allDay: false,
    location: null,
    description: null,
    organiser: null,
    attendees: [],
    myResponse: null,
    meetingUrl: null,
    busy: true,
    private: false,
    seriesId: 'standup',
    webUrl: null,
    createdByCommander: null,
  };
  return store.saveFromSource({
    source: 'outlook-calendar',
    account: SAM,
    items: [{ externalId: `standup-${id}`, kind: 'event', title: 'TL standup', detail }],
  }).created[0] as string;
}

// Ares suggested one Project and the User chose another (a correction), or kept it.
function answer(itemId: string, from: Project, to: Project) {
  store.record(
    { type: 'update', itemId, changes: { filing: { projectId: from.id, filedBy: 'ares' } } },
    { by: { kind: 'ares' } },
  );
  store.record({ type: 'update', itemId, changes: { filing: { projectId: to.id, filedBy: 'user' } } }, user);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-event-rule-suggestions-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
  });
  lt = project('Longtail', 'LT');
  tl = project('Titanlink', 'TL');
  queue = createUpdateQueue({ store: store.updates });
  suggestions = createRuleSuggestions({ itemStore: store, queue });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Rule suggestions for events', () => {
  it('five consistent answers for one calendar queue "Always file events in calendar … under TL?"', () => {
    for (let i = 0; i < 5; i++) answer(event(), lt, tl);
    suggestions.sweep();
    const [line] = queue.list().filter((each) => each.about.kind === 'rule-suggestion');
    expect(line).toMatchObject({
      group: 'decision',
      section: 'calendar',
      about: {
        field: 'google-calendar.calendar',
        value: STANDUPS.id,
        label: STANDUPS.name,
        code: 'TL',
        count: 5,
      },
    });
    expect(templateText(line as never, () => null)).toBe(
      'You filed 5 events in calendar Titanlink Standups under TL. Always file events in calendar Titanlink Standups under TL?',
    );
    // Accepting makes the calendar Rule, which then files the next instance.
    const rule = store.changeRule({ type: 'create', rule: ruleSuggestionDraft(line?.about as never) });
    expect(rule).toBeTruthy();
    expect(store.get(event())?.item.filing).toMatchObject({ projectId: tl.id, filedBy: 'rule' });
  });
});
