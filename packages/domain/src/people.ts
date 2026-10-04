import { z } from 'zod';
import type { ItemDetail } from './items';

/*
  People: someone the User works with, recognised as the same human across Sources (#117, decision
  #28). Items keep their people as handles, as their Source gave them: `linear:<user id>`,
  `github:<login>`, `teams:<Microsoft user id>`, or an email address. A Person gathers every handle
  that is the same human, and is matched deterministically: a handle seen together with an email
  address joins the Person who has that address (case-insensitively). Names never match People on
  their own; the User merges and splits where the matching is wrong, and their merges, splits and
  renames always stand.

  A Person is not an Item, so changes to People are kept in their own People log, which powers undo.
*/

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();

// A handle: `<source>:<id>` or an email address.
export const personHandle = z.string().trim().min(1);

// What a Source says about one of its people as it hands an Item over: the handle, the email address
// it gave for them, and their name. Adapters that know more than an Item's detail holds (a GitHub
// login's public or commit email) hand these over with the Item; the rest is read from the detail.
export const identity = z.object({
  handle: personHandle,
  email: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});
export type Identity = z.input<typeof identity>;
// An identity as matching reads it: handle normalised, email lower-cased.
export type SeenIdentity = { handle: string; email: string | null; name: string | null };

export const handleSources = ['linear', 'github', 'teams', 'email', 'other'] as const;
export type HandleSource = (typeof handleSources)[number];

const EMAIL = /^[^\s:@]+@[^\s:@]+$/;
export const isEmailHandle = (handle: string): boolean => EMAIL.test(handle.trim());

// One spelling per handle: email addresses and GitHub logins are case-insensitive, so they are
// lower-cased; Linear and Microsoft ids are kept as they are.
export function normaliseHandle(handle: string): string {
  const trimmed = handle.trim();
  if (isEmailHandle(trimmed)) return trimmed.toLowerCase();
  if (trimmed.toLowerCase().startsWith('github:')) return `github:${trimmed.slice(7).toLowerCase()}`;
  return trimmed;
}

export function handleSource(handle: string): HandleSource {
  if (isEmailHandle(handle)) return 'email';
  const prefix = handle.slice(0, handle.indexOf(':')).toLowerCase();
  return prefix === 'linear' || prefix === 'github' || prefix === 'teams' ? prefix : 'other';
}

const emailOf = (email: string | null | undefined): string | null =>
  email && isEmailHandle(email) ? email.trim().toLowerCase() : null;

/**
 * Who an Item's people are, as its Source said: the identities handed over with it first, then each
 * person its detail names (a Linear issue's assignee, creator and commenters with their emails and
 * full names; a Chat's members; an event's organiser and guests; an email's sender and recipients;
 * GitHub logins), then any handle in `people` not named yet. Once per handle, the first saying wins,
 * filled in by later ones.
 */
export function identitiesOf(item: {
  people: readonly string[];
  detail: ItemDetail | null;
  identities?: readonly Identity[] | undefined;
}): SeenIdentity[] {
  const found = new Map<string, SeenIdentity>();
  const add = (raw: string | null | undefined, email?: string | null, name?: string | null) => {
    if (!raw?.trim()) return;
    const handle = normaliseHandle(raw);
    const seen = found.get(handle);
    const address = emailOf(email) ?? (isEmailHandle(handle) ? handle : null);
    const named = name?.trim() || null;
    if (!seen) found.set(handle, { handle, email: address, name: named });
    else found.set(handle, { handle, email: seen.email ?? address, name: seen.name ?? named });
  };
  for (const each of item.identities ?? []) add(each.handle, each.email, each.name);
  const detail = item.detail;
  switch (detail?.kind) {
    case 'linear-issue': {
      const users = [detail.assignee, detail.creator, ...detail.comments.map((comment) => comment.author)];
      for (const user of users) if (user) add(`linear:${user.id}`, user.email, user.name);
      break;
    }
    case 'chat':
      for (const member of detail.members) {
        if (member.userId) add(`teams:${member.userId}`, member.email, member.name);
        else if (member.email) add(member.email, member.email, member.name);
      }
      for (const message of detail.messages) {
        if (message.from?.userId) add(`teams:${message.from.userId}`, null, message.from.name);
      }
      break;
    case 'event':
      for (const each of [detail.organiser, ...detail.attendees.filter((one) => !one.resource)]) {
        if (each) add(each.email, each.email, each.name);
      }
      break;
    case 'email':
      for (const each of [detail.from, ...detail.to, ...detail.cc, ...detail.bcc]) {
        if (each) add(each.address, each.address, each.name);
      }
      break;
    case 'pull-request':
      for (const login of [
        detail.author,
        ...detail.assignees,
        ...detail.requestedReviewers.flatMap((each) => (each.kind === 'user' ? [each.login] : [])),
        ...detail.reviews.map((review) => review.login),
      ])
        if (login) add(`github:${login}`);
      break;
    case 'github-issue':
      for (const login of [detail.author, ...detail.assignees]) if (login) add(`github:${login}`);
      break;
    case 'github-release':
      if (detail.author) add(`github:${detail.author}`);
      break;
  }
  for (const handle of item.people) add(handle);
  // An address named only as some other handle's email is that handle's: not a person of its own.
  const emails = new Set(
    [...found.values()].flatMap((each) => (each.handle !== each.email && each.email ? [each.email] : [])),
  );
  return [...found.values()].filter(
    (each) => !(isEmailHandle(each.handle) && emails.has(each.handle) && !each.name),
  );
}

// How much a Source's name for a handle counts towards a Person's name: a Linear or Teams full name
// over a GitHub name over a name given beside an address (a calendar guest, an email's sender).
function nameRank(handle: string): number {
  switch (handleSource(handle)) {
    case 'linear':
    case 'teams':
      return 3;
    case 'github':
      return 2;
    case 'email':
      return 1;
    default:
      return 0;
  }
}

/**
 * The name a Person goes by when the User hasn't named them: the richest Source's name for one of
 * their handles (Linear or Teams full name, then GitHub name, then a name beside an address), then
 * their GitHub login, then an address, then a handle as it is. Ties go to the handle first in order.
 */
export function displayName(handles: readonly { handle: string; name: string | null }[]): string {
  let best: { name: string; rank: number } | null = null;
  for (const { handle, name } of handles) {
    const rank = nameRank(handle);
    if (name?.trim() && (!best || rank > best.rank)) best = { name: name.trim(), rank };
  }
  if (best) return best.name;
  const login = handles.find(({ handle }) => handleSource(handle) === 'github');
  if (login) return login.handle.slice('github:'.length);
  const address = handles.find(({ handle }) => isEmailHandle(handle));
  return address?.handle ?? handles[0]?.handle ?? 'Someone';
}

/**
 * The User's own handles in one of their Accounts: their Linear user, their Microsoft user and
 * work address (Teams and Outlook), their GitHub login, their Google address. Empty while the
 * Account doesn't know who signed in.
 */
export function ownHandles(account: {
  source: string;
  user: { id: string; name: string } | null;
  login?: string;
  email?: string;
  userPrincipalName?: string;
}): string[] {
  const address = (raw: string | undefined) => (raw && isEmailHandle(raw) ? [raw.trim().toLowerCase()] : []);
  switch (account.source) {
    case 'linear':
      return account.user ? [`linear:${account.user.id}`] : [];
    case 'teams':
    case 'outlook':
      return [...(account.user ? [`teams:${account.user.id}`] : []), ...address(account.userPrincipalName)];
    case 'github':
      return account.login ? [normaliseHandle(`github:${account.login}`)] : [];
    case 'google':
      return address(account.email);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------------------------
// People as the window sees them, and the User's changes to them

export const personHandleView = z.object({
  handle: z.string(),
  source: z.enum(handleSources),
  // The Source's name for this handle, when it gave one.
  name: z.string().nullable(),
});
export type PersonHandleView = z.infer<typeof personHandleView>;

export const person = z.object({
  id,
  // The name they go by: the User's, or else the richest Source's (displayName).
  name: z.string(),
  // The User's own name for them (Rename), which wins over every Source's; null when they haven't.
  userName: z.string().nullable(),
  // This Person is the User, recognised from their Accounts.
  isUser: z.boolean(),
  // Every handle, Source handles first (Linear, Teams, GitHub), then addresses.
  handles: z.array(personHandleView),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Person = z.infer<typeof person>;

const personName = z.string().trim().min(1, 'A name can’t be empty').max(200);

// Every change the User makes to People is one of these, kept in the People log so it can be undone.
export const peopleAction = z.discriminatedUnion('type', [
  // `personId` joins `into` (which is kept), going by `name`: the kept name, chosen by the User.
  z.object({ type: z.literal('merge'), personId: id, into: id, name: personName.optional() }),
  // Moves these handles of the Person out to a new Person of their own.
  z.object({ type: z.literal('split'), personId: id, handles: z.array(z.string().min(1)).min(1) }),
  // The User's name for them, which wins over Sources'; null goes back to the Sources' name.
  z.object({ type: z.literal('rename'), personId: id, name: personName.nullable() }),
  // Reverses an entry in the People log; undoing an undo redoes it.
  z.object({ type: z.literal('undo'), changeId: z.number().int().positive() }),
]);
export type PeopleAction = z.input<typeof peopleAction>;

// `match`: matching joined two People it found to be one (an email address they share).
export const peopleChangeAction = z.enum(['merge', 'split', 'rename', 'undo', 'match']);
export type PeopleChangeAction = z.infer<typeof peopleChangeAction>;

// One entry in the People log, as the window sees it.
export const peopleChange = z.object({
  id: z.number().int().positive(),
  at: timestamp,
  action: peopleChangeAction,
  // The Person changed (the one kept, for a merge; the one split from, for a split), as it is now.
  person: person.nullable(),
  // The other Person: the one merged away, or the new one a split made.
  otherId: id.nullable(),
  why: z.string().nullable(),
  // For an undo: the entry it reversed.
  undoes: z.number().int().positive().nullable(),
});
export type PeopleChange = z.infer<typeof peopleChange>;

/** The Person a handle belongs to, from a list of People (the window's resolver). */
export function peopleByHandle(people: readonly Person[]): Map<string, Person> {
  const byHandle = new Map<string, Person>();
  for (const each of people) for (const { handle } of each.handles) byHandle.set(handle, each);
  return byHandle;
}
