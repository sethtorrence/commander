import { describe, expect, it } from 'vitest';
import { describeItemActions } from './activity';

describe('describeItemActions', () => {
  it('says what a suggestion would do, in plain words, leaving out the Links that come with it', () => {
    expect(
      describeItemActions([
        { type: 'create', item: { kind: 'todo', title: 'Book flights' } },
        { type: 'link', from: { step: 0 }, linkType: 'made-from', to: 'block-1' },
      ]),
    ).toEqual(['Add the Todo “Book flights”']);
  });

  it('names each change an update makes', () => {
    expect(
      describeItemActions([
        { type: 'update', itemId: 'm1', changes: { status: 'archived', title: 'Q3 numbers (sent)' } },
        { type: 'update', itemId: 'm1', changes: { filing: { projectId: 'TL', filedBy: 'ares' } } },
        { type: 'update', itemId: 'm1', changes: { filing: null } },
      ]),
    ).toEqual(['Mark it archived', 'Rename it “Q3 numbers (sent)”', 'File it under TL', 'Unfile it']);
  });

  it('names the answer a reply to an invitation would give', () => {
    expect(
      describeItemActions([{ type: 'edit-fields', itemId: 'e1', fields: { response: 'declined' } }]),
    ).toEqual(['Decline the invitation']);
    expect(
      describeItemActions([
        { type: 'edit-fields', itemId: 'e1', fields: { response: 'tentative', seriesResponse: 'tentative' } },
      ]),
    ).toEqual(['Answer Maybe to every event in the series']);
  });

  it('shows the full text of a reply to a Teams Chat (#110)', () => {
    const reply = { clientId: 'c1', text: 'Hi Omar, yes: by Friday.', createdAt: 1 };
    expect(
      describeItemActions([{ type: 'edit-fields', itemId: 'chat-1', fields: { 'message:c1': reply } }]),
    ).toEqual(['Send this reply in Teams: “Hi Omar, yes: by Friday.”']);
  });

  it('says what an action asked for in a Conversation would do (#196): due days, Linear, Snooze, Send to Linear', () => {
    const state = { id: 's', name: 'In Review', type: 'started', color: '#0f783c' };
    const priya = { id: 'u', name: 'Priya Patel', displayName: 'priya', email: null };
    const due = new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(new Date(2026, 9, 9));
    expect(
      describeItemActions(
        [
          {
            type: 'create',
            item: {
              kind: 'todo',
              title: 'Send Leo the redlines',
              filing: { projectId: 'lt', filedBy: 'ares' },
              detail: { kind: 'todo', origin: 'ares', dueOn: '2026-10-09', backedBy: null },
            },
          },
          {
            type: 'update',
            itemId: 't1',
            changes: { detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null } },
          },
          { type: 'edit-fields', itemId: 'i1', fields: { state } },
          { type: 'edit-fields', itemId: 'i1', fields: { assignee: priya } },
          { type: 'edit-fields', itemId: 'i1', fields: { assignee: null } },
          {
            type: 'send-to-linear',
            draft: {
              from: 't1',
              account: 'linear:org',
              team: { id: 'eng', key: 'ENG', name: 'Engineering' },
              title: 'Write the runbook',
              assignee: priya,
              state,
            },
          },
        ],
        (projectId) => (projectId === 'lt' ? 'LT · Longtail' : undefined),
      ),
    ).toEqual([
      `Add the Todo “Send Leo the redlines”, due ${due}, filed under LT · Longtail`,
      'Take its due day away',
      'Move it to In Review in Linear',
      'Assign it to Priya Patel in Linear',
      'Unassign it in Linear',
      'Send it to Linear as a new ENG issue “Write the runbook”, assigned to Priya Patel, in In Review',
    ]);
    const [line] = describeItemActions([
      {
        type: 'edit-fields',
        itemId: 'm1',
        fields: { snooze: { until: new Date(2026, 9, 12, 8).getTime(), returned: false } },
      },
    ]);
    expect(line).toMatch(/^Snooze the thread until .*08:00/);
  });

  it('names a change to one of Ares’s own settings with its two values (#197)', () => {
    expect(
      describeItemActions([
        {
          type: 'change-setting',
          change: { setting: 'monthly-cap', from: null, to: 25 },
          name: 'Monthly cap',
          fromWords: 'No cap',
          toWords: '$25 a month',
        },
      ]),
    ).toEqual(['Change Monthly cap from No cap to $25 a month']);
  });

  it('says plainly when it deletes, and shows Links when they are all it does', () => {
    expect(describeItemActions([{ type: 'delete', itemId: 'm1' }])).toEqual(['Delete it']);
    expect(describeItemActions([{ type: 'link', from: 'a', linkType: 'about', to: 'b' }])).toEqual([
      'Add a Link (about)',
    ]);
  });
});
