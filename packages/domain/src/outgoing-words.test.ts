import { describe, expect, it } from 'vitest';
import type { ItemKind, Source } from './items';
import { changePhrase, changeWords, discardedWhy, isDiscardedWhy } from './outgoing-words';

// A queued change in Commander's own words (#206), from its data alone: Settings → Accounts lists
// "Move to In Review", and the Update says "moving ENG-418 to In Review".

const linear = { kind: 'linear-issue' as const, source: 'linear' as const };
const say = (
  field: string,
  value: unknown,
  synced: unknown = null,
  item: { kind: ItemKind; source: Source } = linear,
) => changeWords({ field, value, synced }, item);

describe('a Linear issue’s changes', () => {
  it('say what moved where, by the names the change carries', () => {
    const state = say('state', { id: 's', name: 'In Review', type: 'started', color: '#000' });
    expect(state).toEqual({ what: 'Move to In Review', verb: 'moving', rest: 'to In Review' });
    expect(changePhrase(state, 'ENG-418')).toBe('moving ENG-418 to In Review');
    expect(say('assignee', { id: 'u', name: 'Priya Patel' }).what).toBe('Assign to Priya Patel');
    expect(changePhrase(say('assignee', null), 'ENG-418')).toBe('unassigning ENG-418');
    expect(say('priority', 1).what).toBe('Set the priority to Urgent');
    expect(say('priority', 0).what).toBe('Clear the priority');
    expect(say('cycle', { number: 42, name: null }).what).toBe('Move to Cycle 42');
    expect(say('linearProject', { id: 'p', name: 'Audit trail' }).what).toBe(
      'Move to the Linear project Audit trail',
    );
    expect(say('estimate', 5).what).toBe('Set the estimate to 5');
  });

  it('give a due date as its calendar day, the same in every time zone', () => {
    expect(say('dueDate', '2026-10-09').what).toBe('Set the due date to 9 Oct');
    expect(say('dueDate', null).what).toBe('Clear the due date');
  });

  it('name a label added, or the one taken away from what the Source had', () => {
    expect(changePhrase(say('label:l1', { id: 'l1', name: 'Bug' }), 'ENG-418')).toBe(
      'labelling ENG-418 “Bug”',
    );
    const removed = say('label:l1', null, { id: 'l1', name: 'Bug' });
    expect(removed.what).toBe('Remove the label “Bug”');
    expect(changePhrase(removed, 'ENG-418')).toBe('removing the label “Bug” from ENG-418');
  });

  it('say a comment, a creation and a deletion plainly', () => {
    expect(changePhrase(say('comment:c1', { body: 'x' }), 'ENG-418')).toBe('commenting on ENG-418');
    expect(say('create', {}).what).toBe('Create in Linear');
    expect(say('delete', true).what).toBe('Delete');
  });
});

describe('other Sources’ changes', () => {
  const email = { kind: 'email' as const, source: 'gmail' as const };
  const event = { kind: 'event' as const, source: 'google-calendar' as const };
  const chat = { kind: 'chat' as const, source: 'teams' as const };

  it('say what was done to an email', () => {
    expect(say('inbox', false, true, email).what).toBe('Archive');
    expect(say('read', true, false, email).what).toBe('Mark as read');
    expect(say('trash', true, false, email).what).toBe('Move to Trash');
    expect(say('folder', { id: 'f', name: 'Receipts' }, null, email).what).toBe('Move to Receipts');
    expect(say('send', {}, null, email).what).toBe('Send');
  });

  it('say an invitation’s answer, and an event moved', () => {
    const accepted = say('response', 'accepted', 'needs-action', event);
    expect(accepted.what).toBe('Answer: Accept');
    expect(changePhrase(accepted, '“Pricing review”')).toBe('accepting “Pricing review”');
    expect(say('seriesResponse', 'declined', null, event).what).toBe('Answer the series: Decline');
    const allDay = { start: { at: 0, timeZone: null, date: '2026-10-08' }, end: {}, allDay: true };
    expect(say('time', allDay, null, event).what).toBe('Move to Thu 8 Oct');
    expect(say('create', {}, null, event).what).toBe('Create in Google Calendar');
  });

  it('say a reply to a Chat', () => {
    expect(changePhrase(say('message:m1', { text: 'Yes' }, null, chat), '“Titanlink eng”')).toBe(
      'replying in “Titanlink eng”',
    );
  });
});

describe('a Discard’s word in the activity log', () => {
  it('names the change and the Source, and is told apart from other words', () => {
    const why = discardedWhy('Move to In Review', 'linear');
    expect(why).toBe('Discarded “Move to In Review”: it didn’t reach Linear');
    expect(isDiscardedWhy(why)).toBe(true);
    expect(isDiscardedWhy('Discarded the draft')).toBe(false);
    expect(isDiscardedWhy(null)).toBe(false);
  });
});
