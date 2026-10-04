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

  it('says plainly when it deletes, and shows Links when they are all it does', () => {
    expect(describeItemActions([{ type: 'delete', itemId: 'm1' }])).toEqual(['Delete it']);
    expect(describeItemActions([{ type: 'link', from: 'a', linkType: 'about', to: 'b' }])).toEqual([
      'Add a Link (about)',
    ]);
  });
});
