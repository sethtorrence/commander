// People-to-Project facts from where People appear (#74, #25): someone on most of the Items the User
// (or a Rule) filed under one Project works mostly on it ("Priya Patel works mostly on TL (Titanlink):
// on 7 of the 9 filed Items with them"). Code, not a model, run on the idle catch-up.
//
// - Counts the latest live Linear issues, Chats and events filed by the User or a Rule (never Ares's
//   own filings, so he never learns from himself) by each Person on them (not the User), per Project.
// - A Person on at least MIN_ITEMS such Items, most (MIN_SHARE) of them under one Project, gets the
//   fact, about them and that Project, with those Items (up to MAX_SOURCES) as its sources. Learned
//   again as more appear, the same fact follows the counts (unless the User edited its words).
// - Unconfirmed until the User confirms it: only ever background to Ares, and never a Rule (#25: a
//   Person's link to a Project helps Ares file but never decides alone).
import { identitiesOf, normaliseHandle, type Person } from '@commander/domain';
import type { ItemStore } from '../item-store';

const MIN_ITEMS = 3;
const MIN_SHARE = 0.6;
const MAX_SOURCES = 10;
const ITEMS_COUNTED = 1000;

/** Learns (or brings up to date) where People work from where they appear. Returns how many are new. */
export function learnAppearances(itemStore: ItemStore): number {
  const people = itemStore.people.list().filter((person) => !person.isUser);
  const owner = new Map<string, Person>();
  for (const person of people) {
    for (const { handle } of person.handles) owner.set(normaliseHandle(handle), person);
  }
  // Each Person's filed Items, by Project.
  const counts = new Map<string, Map<string, string[]>>();
  const items = itemStore.query({ kinds: ['linear-issue', 'chat', 'event'], limit: ITEMS_COUNTED });
  for (const item of items) {
    const filing = item.filing;
    if (!filing || (filing.filedBy !== 'user' && filing.filedBy !== 'rule')) continue;
    const on = new Set<Person>();
    for (const identity of identitiesOf(item)) {
      const person = owner.get(identity.handle);
      if (person) on.add(person);
    }
    for (const person of on) {
      const byProject = counts.get(person.id) ?? new Map<string, string[]>();
      byProject.set(filing.projectId, [...(byProject.get(filing.projectId) ?? []), item.id]);
      counts.set(person.id, byProject);
    }
  }

  const byId = new Map(people.map((person) => [person.id, person]));
  const found: { key: string; person: Person; projectId: string; itemIds: string[]; total: number }[] = [];
  for (const [personId, byProject] of counts) {
    const person = byId.get(personId);
    if (!person) continue;
    const total = [...byProject.values()].reduce((sum, ids) => sum + ids.length, 0);
    const [projectId, itemIds] = [...byProject].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
    if (!projectId || !itemIds || total < MIN_ITEMS || itemIds.length / total < MIN_SHARE) continue;
    found.push({ key: `appears:${personId}:${projectId}`, person, projectId, itemIds, total });
  }

  const known = itemStore.memory.knows(found.map((each) => each.key));
  let learned = 0;
  for (const { key, person, projectId, itemIds, total } of found) {
    const project = itemStore.projectRef(projectId);
    if (!project) continue;
    const memory = itemStore.memory.learn({
      kind: 'fact',
      key,
      text: `${person.name} works mostly on ${project.code} (${project.title}): on ${itemIds.length} of the ${total} filed Items with them`,
      confirmed: false,
      personId: person.id,
      projectId,
      handles: person.handles.map((each) => each.handle),
      sources: itemIds.slice(0, MAX_SOURCES),
    });
    if (memory && !known.has(key)) learned++;
  }
  return learned;
}
