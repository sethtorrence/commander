// The Item store's People (#117): who the people behind Items' handles are, matched across Sources.
// They live in the same database, written only through the Item store, but they are not Items:
// changing them records an entry in the People log (people_changes), not the activity log.
//
// Matching is deterministic. After every save from a Source, each handle the Source named is put with
// the Person who has the email address it came with (case-insensitively), and two People sharing an
// address become one. A handle with no known address is a Person of its own until one links it.
// Names never match anyone. The User's merges and splits pin the handles they place, and matching
// never moves a pinned handle, so it never undoes them; two People both arranged by the User stay
// apart even when an address links them.
import { randomUUID } from 'node:crypto';
import {
  displayName,
  handleSource,
  isEmailHandle,
  normaliseHandle,
  type PeopleAction,
  type PeopleChange,
  type PeopleChangeAction,
  type Person,
  type PersonHandleView,
  peopleAction,
  type SeenIdentity,
} from '@commander/domain';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { z } from 'zod';
import * as schema from './schema';

type PersonRow = schema.PersonRowState;
type HandleRow = typeof schema.personHandles.$inferSelect;
type ChangeRow = typeof schema.peopleChanges.$inferSelect;

export type PeopleStore = {
  // Everyone Commander knows (not merged away), the User first, then by name.
  list(): Person[];
  get(personId: string): Person | null;
  // Makes one of the User's changes to People and logs it. Call inside a transaction.
  change(action: PeopleAction): PeopleChange;
  // The People log, newest first.
  log(limit?: number): PeopleChange[];
  // Puts the handles a Source just named with their People (matching). Call inside the save's
  // transaction.
  seen(identities: readonly SeenIdentity[]): void;
  // Who the User is: their own handles, Account by Account (with the name each Account knows them
  // by). Their People become the User, joined into one where nothing the User arranged stops it.
  recogniseUser(accounts: readonly { handles: readonly string[]; name: string | null }[]): void;
  // Whether there are no People at all (a database from before People existed).
  empty(): boolean;
};

// Where each kind of handle comes in a Person's list: Source handles first, then addresses.
const SOURCE_ORDER = ['linear', 'teams', 'github', 'other', 'email'];

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'That change to People isn’t valid';
}

export function peopleIn(
  db: BetterSQLite3Database<typeof schema>,
  now: () => number,
  invalid: (message: string) => Error,
): PeopleStore {
  const { people, personHandles, peopleChanges } = schema;
  const live = isNull(people.mergedInto);

  const personRow = (id: string) => db.select().from(people).where(eq(people.id, id)).get();
  const handleRow = (handle: string) =>
    db.select().from(personHandles).where(eq(personHandles.handle, handle)).get();
  const handlesOf = (personId: string) =>
    db
      .select()
      .from(personHandles)
      .where(eq(personHandles.personId, personId))
      .orderBy(asc(personHandles.seenAt), asc(personHandles.handle))
      .all();

  function requirePerson(id: string): PersonRow {
    const row = personRow(id);
    if (!row || row.mergedInto !== null) throw invalid(`No Person ${id}`);
    return row;
  }

  function toPerson(row: PersonRow, handles: HandleRow[]): Person {
    const views: PersonHandleView[] = handles
      .map((each) => ({ handle: each.handle, source: handleSource(each.handle), name: each.name }))
      .sort(
        (a, b) =>
          SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || a.handle.localeCompare(b.handle),
      );
    return {
      id: row.id,
      name: row.name,
      userName: row.userName,
      isUser: handles.some((each) => each.own),
      handles: views,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // The name a Person goes by now: the User's, or else the richest Source's.
  function refreshName(personId: string, at: number) {
    const row = personRow(personId);
    if (!row) return;
    const name = row.userName ?? displayName(handlesOf(personId));
    if (name !== row.name)
      db.update(people).set({ name, updatedAt: at }).where(eq(people.id, personId)).run();
  }

  function newPerson(at: number, id: string = randomUUID()): string {
    db.insert(people)
      .values({ id, name: '', userName: null, mergedInto: null, createdAt: at, updatedAt: at })
      .run();
    return id;
  }

  function placeHandle(handle: string, personId: string, name: string | null, at: number) {
    db.insert(personHandles).values({ handle, personId, name, pinned: false, own: false, seenAt: at }).run();
  }

  function snapshot(personIds: readonly string[]): schema.PeopleSnapshot {
    const ids = [...new Set(personIds)];
    if (!ids.length) return { people: [], handles: [] };
    return {
      people: db.select().from(people).where(inArray(people.id, ids)).all(),
      handles: db
        .select({
          handle: personHandles.handle,
          personId: personHandles.personId,
          pinned: personHandles.pinned,
        })
        .from(personHandles)
        .where(inArray(personHandles.personId, ids))
        .orderBy(asc(personHandles.handle))
        .all(),
    };
  }

  function toChange(row: ChangeRow): PeopleChange {
    const kept = personRow(row.personId);
    return {
      id: row.id,
      at: row.at,
      action: row.action,
      person: kept && kept.mergedInto === null ? toPerson(kept, handlesOf(kept.id)) : null,
      otherId: row.otherId,
      why: row.why,
      undoes: row.undoes,
    };
  }

  function log(entry: {
    action: PeopleChangeAction;
    personId: string;
    otherId?: string | null;
    why?: string | null;
    before: schema.PeopleSnapshot;
    after: schema.PeopleSnapshot;
    undoes?: number | null;
  }): PeopleChange {
    const row = db
      .insert(peopleChanges)
      .values({
        at: now(),
        action: entry.action,
        personId: entry.personId,
        otherId: entry.otherId ?? null,
        why: entry.why ?? null,
        before: entry.before,
        after: entry.after,
        undoes: entry.undoes ?? null,
      })
      .returning()
      .get();
    return toChange(row);
  }

  // Moves every handle of `from` to `into`, and marks `from` merged into it.
  function fold(from: PersonRow, into: PersonRow, at: number) {
    db.update(personHandles).set({ personId: into.id }).where(eq(personHandles.personId, from.id)).run();
    db.update(people).set({ mergedInto: into.id, updatedAt: at }).where(eq(people.id, from.id)).run();
  }

  const pinnedIn = (personId: string) =>
    !!db
      .select({ handle: personHandles.handle })
      .from(personHandles)
      .where(and(eq(personHandles.personId, personId), eq(personHandles.pinned, true)))
      .get();

  /*
    Matching found two People to be one (an address they share). The one the User arranged (holding
    pinned handles) is kept, else one the User named, else the older; when both were arranged by the
    User, they stay apart. Logged as `match`. Returns the Person kept, or null when they stay apart.
  */
  function join(aId: string, bId: string, why: string, at: number): string | null {
    const a = personRow(aId);
    const b = personRow(bId);
    if (!a || !b || a.id === b.id || a.mergedInto !== null || b.mergedInto !== null) return null;
    const aPinned = pinnedIn(a.id);
    const bPinned = pinnedIn(b.id);
    if (aPinned && bPinned) return null;
    let [kept, gone] = [a, b];
    if (bPinned && !aPinned) [kept, gone] = [b, a];
    else if (aPinned === bPinned) {
      const named = (row: PersonRow) => (row.userName !== null ? 0 : 1);
      const order = named(a) - named(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
      if (order > 0) [kept, gone] = [b, a];
    }
    const before = snapshot([kept.id, gone.id]);
    fold(gone, kept, at);
    if (kept.userName === null && gone.userName !== null)
      db.update(people).set({ userName: gone.userName }).where(eq(people.id, kept.id)).run();
    refreshName(kept.id, at);
    log({
      action: 'match',
      personId: kept.id,
      otherId: gone.id,
      why,
      before,
      after: snapshot([kept.id, gone.id]),
    });
    return kept.id;
  }

  function seen(identities: readonly SeenIdentity[]) {
    const at = now();
    const touched = new Set<string>();
    for (const identity of identities) {
      const handle = normaliseHandle(identity.handle);
      const email = identity.email && identity.email !== handle ? normaliseHandle(identity.email) : null;
      let row = handleRow(handle);
      if (!row) {
        const byEmail = email ? handleRow(email) : undefined;
        const personId = byEmail ? byEmail.personId : newPerson(at);
        placeHandle(handle, personId, identity.name, at);
        row = handleRow(handle) as HandleRow;
      } else if (identity.name && identity.name !== row.name) {
        db.update(personHandles).set({ name: identity.name }).where(eq(personHandles.handle, handle)).run();
      }
      touched.add(row.personId);
      if (!email) continue;
      const address = handleRow(email);
      if (!address) {
        placeHandle(email, row.personId, null, at);
        continue;
      }
      if (address.personId === row.personId) continue;
      const kept = join(row.personId, address.personId, `${handle} has the address ${email}`, at);
      if (kept) touched.add(kept);
    }
    for (const personId of touched) refreshName(personId, at);
  }

  function merge(personId: string, intoId: string, name: string | undefined): PeopleChange {
    if (personId === intoId) throw invalid('A Person can’t be merged with themselves');
    const from = requirePerson(personId);
    const into = requirePerson(intoId);
    const at = now();
    const before = snapshot([into.id, from.id]);
    fold(from, into, at);
    // The User arranged these handles: matching leaves them where they are from now on.
    db.update(personHandles).set({ pinned: true }).where(eq(personHandles.personId, into.id)).run();
    const fromSources = displayName(handlesOf(into.id));
    const userName =
      name !== undefined ? (name === fromSources ? null : name) : (into.userName ?? from.userName);
    db.update(people).set({ userName, updatedAt: at }).where(eq(people.id, into.id)).run();
    refreshName(into.id, at);
    return log({
      action: 'merge',
      personId: into.id,
      otherId: from.id,
      why: `Merged ${from.name} into ${into.name}`,
      before,
      after: snapshot([into.id, from.id]),
    });
  }

  function split(personId: string, raw: readonly string[]): PeopleChange {
    const from = requirePerson(personId);
    const handles = [...new Set(raw.map(normaliseHandle))];
    const theirs = handlesOf(from.id).map((each) => each.handle);
    const missing = handles.find((handle) => !theirs.includes(handle));
    if (missing) throw invalid(`${missing} isn’t one of ${from.name}’s handles`);
    if (handles.length >= theirs.length) throw invalid(`${from.name} has to keep at least one handle`);
    const at = now();
    const otherId = randomUUID();
    const before = snapshot([from.id]);
    // Before the split, the new Person is as good as merged into the one it came from.
    before.people.push({
      id: otherId,
      name: '',
      userName: null,
      mergedInto: from.id,
      createdAt: at,
      updatedAt: at,
    });
    newPerson(at, otherId);
    db.update(personHandles).set({ personId: otherId }).where(inArray(personHandles.handle, handles)).run();
    // The User arranged both: matching never joins them back, nor moves these handles.
    db.update(personHandles)
      .set({ pinned: true })
      .where(inArray(personHandles.personId, [from.id, otherId]))
      .run();
    refreshName(from.id, at);
    refreshName(otherId, at);
    return log({
      action: 'split',
      personId: from.id,
      otherId,
      why: `Split ${handles.join(', ')} from ${from.name}`,
      before,
      after: snapshot([from.id, otherId]),
    });
  }

  function rename(personId: string, name: string | null): PeopleChange {
    const row = requirePerson(personId);
    const at = now();
    const before = snapshot([row.id]);
    db.update(people).set({ userName: name, updatedAt: at }).where(eq(people.id, row.id)).run();
    refreshName(row.id, at);
    return log({
      action: 'rename',
      personId: row.id,
      why: name === null ? `${row.name} goes by the Sources’ name again` : `Renamed ${row.name} to ${name}`,
      before,
      after: snapshot([row.id]),
    });
  }

  // Where a handle left in a Person merged away belongs: the live Person that one went into.
  function liveInto(personId: string): string | null {
    let row = personRow(personId);
    for (let hops = 0; row?.mergedInto && hops < 100; hops++) row = personRow(row.mergedInto);
    return row && row.mergedInto === null ? row.id : null;
  }

  /*
    Puts back what an entry changed: the People rows it touched as they were before it, and each
    handle it moved, unless the handle has been moved again since. Handles that came to a Person
    since stay with it, or follow it into the Person it is folded back into. Undoing an undo redoes.
  */
  function undo(changeId: number): PeopleChange {
    const target = db.select().from(peopleChanges).where(eq(peopleChanges.id, changeId)).get();
    if (!target) throw invalid(`No change to People ${changeId}`);
    if (target.action === 'match') {
      throw invalid('Commander matched these People by an address they share. Split them instead');
    }
    if (db.select().from(peopleChanges).where(eq(peopleChanges.undoes, changeId)).get())
      throw invalid('That change is already undone');
    const at = now();
    const ids = [...target.before.people, ...target.after.people].map((row) => row.id);
    const current = snapshot(ids);
    for (const { id, ...values } of target.before.people) {
      const { name: _name, ...kept } = values;
      db.update(people)
        .set({ ...kept, updatedAt: at })
        .where(eq(people.id, id))
        .run();
    }
    const afterOf = new Map(target.after.handles.map((each) => [each.handle, each]));
    for (const was of target.before.handles) {
      const now = handleRow(was.handle);
      const after = afterOf.get(was.handle);
      if (!now || (after && now.personId !== after.personId)) continue;
      db.update(personHandles)
        .set({ personId: was.personId, pinned: was.pinned })
        .where(eq(personHandles.handle, was.handle))
        .run();
    }
    for (const id of new Set(ids)) {
      const row = personRow(id);
      if (row?.mergedInto === null) continue;
      const into = liveInto(id);
      if (into) db.update(personHandles).set({ personId: into }).where(eq(personHandles.personId, id)).run();
    }
    for (const id of new Set(ids)) refreshName(id, at);
    const what = target.why ? target.why.charAt(0).toLowerCase() + target.why.slice(1) : target.action;
    return log({
      action: 'undo',
      personId: target.personId,
      otherId: target.otherId,
      why: target.action === 'undo' ? `Redid: ${what}` : `Undid: ${what}`,
      before: current,
      after: snapshot(ids),
      undoes: target.id,
    });
  }

  function recogniseUser(accounts: readonly { handles: readonly string[]; name: string | null }[]) {
    const at = now();
    db.update(personHandles).set({ own: false }).where(eq(personHandles.own, true)).run();
    const mine: string[] = [];
    for (const account of accounts) {
      for (const raw of account.handles) {
        const handle = normaliseHandle(raw);
        const row = handleRow(handle);
        // The name the Account knows the User by names their handle there, if its Source gave none.
        const name = isEmailHandle(handle) ? null : account.name;
        if (!row) placeHandle(handle, newPerson(at), name, at);
        else if (!row.name && name)
          db.update(personHandles).set({ name }).where(eq(personHandles.handle, handle)).run();
        db.update(personHandles).set({ own: true }).where(eq(personHandles.handle, handle)).run();
        mine.push(handle);
      }
    }
    let kept: string | null = null;
    for (const handle of mine) {
      const personId = handleRow(handle)?.personId;
      if (!personId) continue;
      if (kept === null || kept === personId) kept = personId;
      else kept = join(kept, personId, 'Both are you, from your Accounts', at) ?? kept;
      refreshName(personId, at);
    }
    if (kept) refreshName(kept, at);
  }

  return {
    list() {
      const rows = db.select().from(people).where(live).all();
      const handles = db
        .select()
        .from(personHandles)
        .orderBy(asc(personHandles.seenAt), asc(personHandles.handle))
        .all();
      const byPerson = new Map<string, HandleRow[]>();
      for (const each of handles) byPerson.set(each.personId, [...(byPerson.get(each.personId) ?? []), each]);
      return rows
        .flatMap((row) => {
          const theirs = byPerson.get(row.id);
          return theirs?.length ? [toPerson(row, theirs)] : [];
        })
        .sort(
          (a, b) =>
            Number(b.isUser) - Number(a.isUser) ||
            a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
            a.id.localeCompare(b.id),
        );
    },

    get(personId) {
      const id = liveInto(personId);
      const row = id ? personRow(id) : undefined;
      return row ? toPerson(row, handlesOf(row.id)) : null;
    },

    change(input) {
      const parsed = peopleAction.safeParse(input);
      if (!parsed.success) throw invalid(firstIssue(parsed.error));
      const action = parsed.data;
      switch (action.type) {
        case 'merge':
          return merge(action.personId, action.into, action.name);
        case 'split':
          return split(action.personId, action.handles);
        case 'rename':
          return rename(action.personId, action.name);
        case 'undo':
          return undo(action.changeId);
      }
    },

    log: (limit = 200) =>
      db.select().from(peopleChanges).orderBy(desc(peopleChanges.id)).limit(limit).all().map(toChange),

    seen,
    recogniseUser,
    empty: () => !db.select({ id: people.id }).from(people).limit(1).get(),
  };
}
