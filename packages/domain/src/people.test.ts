import { describe, expect, it } from 'vitest';
import type { ItemDetail } from './items';
import type { LinearIssueDetail } from './linear';
import { displayName, handleSource, identitiesOf, normaliseHandle, ownHandles } from './people';
import type { ChatDetail } from './teams';

// People in the domain: handles as Sources give them, what each Source says about who a handle is
// (its email address and name), and the name a Person goes by.

const PRIYA_LINEAR = { id: 'u-priya', name: 'Priya Patel', displayName: 'priya', email: 'Priya@Acme.io' };

describe('handles', () => {
  it('folds email addresses and GitHub logins to one case, and leaves other ids alone', () => {
    expect(normaliseHandle(' Priya@Acme.IO ')).toBe('priya@acme.io');
    expect(normaliseHandle('github:Priya-P')).toBe('github:priya-p');
    expect(normaliseHandle('linear:U-Priya')).toBe('linear:U-Priya');
    expect(normaliseHandle('teams:9f2C')).toBe('teams:9f2C');
  });

  it('says which Source a handle belongs to, or that it is an email address', () => {
    expect(handleSource('linear:u-1')).toBe('linear');
    expect(handleSource('github:octocat')).toBe('github');
    expect(handleSource('teams:9f2c')).toBe('teams');
    expect(handleSource('priya@acme.io')).toBe('email');
  });
});

describe('identitiesOf', () => {
  it('reads a Linear issue’s assignee, creator and commenters with their emails and full names', () => {
    const detail = {
      kind: 'linear-issue',
      assignee: PRIYA_LINEAR,
      creator: { id: 'u-sam', name: 'Sam Rivera', displayName: 'sam', email: null },
      comments: [
        { id: 'c1', author: { id: 'u-li', name: 'Li Wei', displayName: 'li', email: 'li@acme.io' } },
      ],
    } as unknown as LinearIssueDetail;
    const found = identitiesOf({ people: ['linear:u-priya', 'priya@acme.io', 'linear:u-sam'], detail });
    expect(found).toEqual([
      { handle: 'linear:u-priya', email: 'priya@acme.io', name: 'Priya Patel' },
      { handle: 'linear:u-sam', email: null, name: 'Sam Rivera' },
      { handle: 'linear:u-li', email: 'li@acme.io', name: 'Li Wei' },
    ]);
  });

  it('reads a Chat’s members, and members without a Microsoft id by their address', () => {
    const detail = {
      kind: 'chat',
      members: [
        { userId: 'u-priya', name: 'Priya Patel', email: 'priya@acme.io' },
        { userId: null, name: 'Guest Gus', email: 'gus@outside.test' },
      ],
      messages: [],
    } as unknown as ChatDetail;
    expect(identitiesOf({ people: [], detail })).toEqual([
      { handle: 'teams:u-priya', email: 'priya@acme.io', name: 'Priya Patel' },
      { handle: 'gus@outside.test', email: 'gus@outside.test', name: 'Guest Gus' },
    ]);
  });

  it('reads an email’s sender and recipients by their addresses, with the names beside them', () => {
    const detail = {
      kind: 'email',
      from: { name: 'Priya Patel', address: 'Priya@Acme.io' },
      to: [{ name: null, address: 'sam@contoso.test' }],
      cc: [{ name: 'Lee Chen', address: 'lee@acme.io' }],
      bcc: [],
    } as unknown as ItemDetail;
    expect(identitiesOf({ people: [], detail })).toEqual([
      { handle: 'priya@acme.io', email: 'priya@acme.io', name: 'Priya Patel' },
      { handle: 'sam@contoso.test', email: 'sam@contoso.test', name: null },
      { handle: 'lee@acme.io', email: 'lee@acme.io', name: 'Lee Chen' },
    ]);
  });

  it('takes what the Source said about its people first, then GitHub logins, then any handle left', () => {
    const found = identitiesOf({
      people: ['github:priya-p', 'github:octocat', 'priya@acme.io', 'gus@outside.test'],
      detail: null,
      identities: [{ handle: 'github:Priya-P', email: 'priya@acme.io', name: 'Priya P.' }],
    });
    expect(found).toEqual([
      { handle: 'github:priya-p', email: 'priya@acme.io', name: 'Priya P.' },
      { handle: 'github:octocat', email: null, name: null },
      { handle: 'gus@outside.test', email: 'gus@outside.test', name: null },
    ]);
  });
});

describe('displayName', () => {
  const h = (handle: string, name: string | null = null) => ({ handle, name });

  it('prefers a Linear or Teams full name, then a GitHub name, then a name beside an address', () => {
    expect(displayName([h('github:pp', 'Priya P.'), h('linear:u-1', 'Priya Patel')])).toBe('Priya Patel');
    expect(displayName([h('priya@acme.io', 'priya'), h('github:pp', 'Priya P.')])).toBe('Priya P.');
    expect(displayName([h('priya@acme.io', 'Priya (Acme)'), h('github:pp')])).toBe('Priya (Acme)');
  });

  it('falls back to the GitHub login, then the address, then the handle itself', () => {
    expect(displayName([h('priya@acme.io'), h('github:priya-p')])).toBe('priya-p');
    expect(displayName([h('linear:u-1'), h('priya@acme.io')])).toBe('priya@acme.io');
    expect(displayName([h('teams:9f2c')])).toBe('teams:9f2c');
  });
});

describe('ownHandles', () => {
  it('reads who the User is from each kind of Account', () => {
    const user = { id: 'u-me', name: 'Sam Rivera' };
    expect(ownHandles({ source: 'linear', user })).toEqual(['linear:u-me']);
    expect(ownHandles({ source: 'teams', user, userPrincipalName: 'Sam@Contoso.test' })).toEqual([
      'teams:u-me',
      'sam@contoso.test',
    ]);
    expect(ownHandles({ source: 'outlook', user, userPrincipalName: 'sam@outlook.test' })).toEqual([
      'teams:u-me',
      'sam@outlook.test',
    ]);
    expect(ownHandles({ source: 'github', user: { id: '42', name: 'Sam' }, login: 'SamR' })).toEqual([
      'github:samr',
    ]);
    expect(
      ownHandles({ source: 'google', user: { id: '1045', name: 'Sam' }, email: 'sam@gmail.test' }),
    ).toEqual(['sam@gmail.test']);
    expect(ownHandles({ source: 'linear', user: null })).toEqual([]);
  });
});
