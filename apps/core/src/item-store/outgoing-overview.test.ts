import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, EventDetail, LinearIssueDetail, SourceItem } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Changes that didn't reach a Source, as Settings → Accounts lists them (#206), and Discard: the
// changes leave the queue and the Item goes back to what the Source has, with nothing queued, logged
// as the User's. An Item the Source never had goes; a message is the Outbox's to look after.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const ACME = 'linear:org-acme';
const ALEX = 'google:104512345678901234567';
const PRIMARY = 'alex@gmail.test';
const user: ActionContext = { by: { kind: 'user' } };
const bug = { id: 'label-bug', name: 'Bug', color: '#eb5757' };
const progress = { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' };
const review = { id: 'state-review', name: 'In Review', type: 'started', color: '#5e6ad2' };
const done = { id: 'state-done', name: 'Done', type: 'completed', color: '#5e6ad2' };
const HOUR = 60 * 60_000;

let dir: string;
let store: ItemStore;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-outgoing-overview-'));
  clock = Date.UTC(2026, 9, 3, 9);
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const base: LinearIssueDetail = {
  kind: 'linear-issue',
  identifier: 'ENG-418',
  url: 'https://linear.app/acme/issue/ENG-418',
  team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
  state: progress,
  priority: 2,
  assignee: null,
  creator: null,
  labels: [bug],
  cycle: null,
  linearProject: null,
  dueDate: null,
  estimate: 3,
  description: null,
  comments: [],
  createdAt: Date.UTC(2026, 8, 29),
  updatedAt: Date.UTC(2026, 9, 1),
  startedAt: null,
  completedAt: null,
  canceledAt: null,
};

const issue = (detail: Partial<LinearIssueDetail> = {}): SourceItem => ({
  externalId: 'issue-418',
  kind: 'linear-issue',
  title: 'Fix the login loop',
  detail: { ...base, ...detail },
});

function issueId() {
  const [found] = store.query({ kinds: ['linear-issue'] });
  if (!found) throw new Error('No issue saved');
  return found.id;
}

const detailOf = () => store.get(issueId())?.item.detail as LinearIssueDetail;
const edit = (fields: Record<string, unknown>) =>
  store.record({ type: 'edit-fields', itemId: issueId(), fields }, user);

// The queued changes stop as Couldn't sync, as the sync engine leaves them after a refusal.
function refuse(error = 'The issue is locked for editing.') {
  const ids = store.outgoing.rows().map((row) => row.id);
  store.outgoing.fail(ids, { error, failed: true, nextAttemptAt: null });
  return ids;
}

describe('the changes Settings → Accounts lists', () => {
  beforeEach(() => {
    store.saveFromSource({ source: 'linear', account: ACME, items: [issue()] });
  });

  it('says each one in Commander’s words, on which Item, when, how it stands and why it stopped', () => {
    edit({ state: done });
    clock += 60_000;
    edit({ 'label:label-bug': null });
    refuse();
    expect(store.outgoingEntries({ account: ACME })).toEqual([
      expect.objectContaining({
        field: 'state',
        what: 'Move to Done',
        item: { title: 'Fix the login loop', label: 'ENG-418', kind: 'linear-issue' },
        madeAt: Date.UTC(2026, 9, 3, 9),
        status: 'failed',
        error: 'The issue is locked for editing.',
        message: null,
      }),
      expect.objectContaining({ field: 'label:label-bug', what: 'Remove the label “Bug”', status: 'failed' }),
    ]);
    expect(store.outgoingEntries({ account: 'linear:other' })).toEqual([]);
  });
});

describe('Discard', () => {
  beforeEach(() => {
    store.saveFromSource({ source: 'linear', account: ACME, items: [issue()] });
  });

  it('puts the Item back as the Source has it, queues nothing, and logs it as the User’s', () => {
    edit({ state: review, priority: 1 });
    const [state] = refuse();
    clock += HOUR;

    const [entry] = store.discardChanges([state as number], user);

    // Only the change discarded goes back: the priority is still on its way.
    expect(detailOf()).toMatchObject({ state: progress, priority: 1 });
    expect(store.outgoing.rows().map((row) => row.field)).toEqual(['priority']);
    expect(entry).toMatchObject({
      action: 'update',
      by: { kind: 'user' },
      itemId: issueId(),
      why: 'Discarded “Move to In Review”: it didn’t reach Linear',
    });
  });

  it('brings back a label whose removal didn’t go, and a deleted comment', () => {
    const comment = { id: 'c-1', author: null, body: 'Seen it.', createdAt: 1, updatedAt: 1 };
    store.saveFromSource({ source: 'linear', account: ACME, items: [issue({ comments: [comment] })] });
    edit({ 'label:label-bug': null, 'comment:c-1': null });
    const ids = refuse();
    store.discardChanges(ids, user);
    expect(detailOf()).toMatchObject({ labels: [bug], comments: [comment] });
    expect(store.outgoing.rows()).toEqual([]);
  });

  it('takes a change still waiting (not yet Couldn’t sync) out of the queue too', () => {
    edit({ estimate: 5 });
    const [row] = store.outgoing.rows();
    store.discardChanges([row?.id as number], user);
    expect(detailOf().estimate).toBe(3);
    expect(store.outgoing.rows()).toEqual([]);
  });

  it('is refused for a change on its way, and leaves it queued', () => {
    edit({ estimate: 5 });
    const [row] = store.outgoing.rows();
    store.outgoing.markSending([row?.id as number], clock);
    expect(() => store.discardChanges([row?.id as number], user)).toThrow(/on its way to Linear/);
    expect(store.outgoing.rows()).toHaveLength(1);
    expect(detailOf().estimate).toBe(5);
  });

  it('can’t be undone: making the change again is the way back', () => {
    edit({ state: done });
    const [entry] = store.discardChanges(refuse(), user);
    expect(() => store.record({ type: 'undo', entryId: entry?.id as number }, user)).toThrow(
      /discarded change can’t be undone/,
    );
  });

  it('says so when the changes are gone already (sent, or discarded)', () => {
    edit({ state: done });
    const ids = refuse();
    store.discardChanges(ids, user);
    expect(() => store.discardChanges(ids, user)).toThrow(/no longer waiting/);
  });
});

describe('Discard of a calendar event Commander made', () => {
  const time = (at: number) => ({ at, timeZone: 'Europe/London', date: null });
  const START = Date.UTC(2026, 9, 8, 8);

  beforeEach(() => {
    store.calendars.listed(ALEX, 'google-calendar', [
      { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7', primary: true, accessRole: 'owner' },
    ]);
  });

  const focusBlock = () =>
    store.createEvent(
      {
        kind: 'focus-block',
        account: ALEX,
        title: 'Focus: Fix the login bug',
        start: time(START),
        end: time(START + 2 * HOUR),
      },
      user,
    ).itemId;
  const eventOf = (itemId: string) => store.get(itemId)?.item.detail as EventDetail;

  it('one the Source never had goes, with everything queued for it', () => {
    const itemId = focusBlock();
    store.moveEvent(itemId, { start: time(START + HOUR), end: time(START + 3 * HOUR), allDay: false }, user);
    const [create] = store.outgoing.rows();
    store.outgoing.fail([create?.id as number], { error: 'Refused', failed: true, nextAttemptAt: null });

    const [entry] = store.discardChanges([create?.id as number], user);
    expect(entry).toMatchObject({
      action: 'delete',
      why: 'Discarded “Create in Google Calendar”: it didn’t reach Google Calendar',
    });
    expect(store.get(itemId)?.item.deletedAt).toBe(clock);
    expect(store.outgoing.rows()).toEqual([]);
  });

  it('a move that didn’t go puts it back at the time the Source has', () => {
    const itemId = focusBlock();
    const [create] = store.outgoing.rows();
    store.outgoing.settle([create?.id as number]);
    store.moveEvent(itemId, { start: time(START + HOUR), end: time(START + 3 * HOUR), allDay: false }, user);
    const ids = store.outgoing.rows().map((row) => row.id);
    store.outgoing.fail(ids, { error: 'Refused', failed: true, nextAttemptAt: null });
    expect(store.outgoingEntries()[0]?.what).toMatch(/^Move to /);

    store.discardChanges(ids, user);
    expect(eventOf(itemId)).toMatchObject({ start: time(START), end: time(START + 2 * HOUR) });
    expect(store.outgoing.rows()).toEqual([]);
  });

  it('a deletion that didn’t go brings it back', () => {
    const itemId = focusBlock();
    const [create] = store.outgoing.rows();
    store.outgoing.settle([create?.id as number]);
    store.record({ type: 'delete', itemId }, user);
    const ids = store.outgoing.rows().map((row) => row.id);
    store.discardChanges(ids, user);
    expect(store.get(itemId)?.item.deletedAt).toBeNull();
    expect(store.outgoing.rows()).toEqual([]);
  });
});

describe('a message written in Commander', () => {
  const SAM = 'google:sam';
  const me = { name: 'Sam Rivera', address: 'sam@home.test' };
  const dana = { name: 'Dana Whitfield', address: 'dana@northwind.test' };

  it('is the Outbox’s to look after: listed with where it is, never discarded here', () => {
    const { itemId } = store.compose.send(
      {
        mode: 'new',
        account: SAM,
        replyToItemId: null,
        to: [dana],
        cc: [],
        bcc: [],
        subject: 'Offsite dates',
        body: [{ type: 'paragraph', runs: [{ text: 'Thursday works.' }] }],
        attachments: [],
      },
      { by: { kind: 'user' }, source: 'gmail', from: me },
      clock,
    );
    const ids = store.outgoing.rows().map((row) => row.id);
    store.outgoing.fail(ids, { error: 'Gmail refused it.', failed: true, nextAttemptAt: null });

    const sending = store.outgoingEntries({ account: SAM }).filter((entry) => entry.field === 'send');
    expect(sending).toEqual([
      expect.objectContaining({
        what: 'Send',
        message: 'outbox',
        item: expect.objectContaining({ kind: 'email' }),
      }),
    ]);
    expect(() => store.discardChanges(ids, user)).toThrow(/Outbox/);
    expect(store.outgoing.forItem(itemId).map((row) => row.field)).toContain('send');
  });
});
