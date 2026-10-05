import { z } from 'zod';
import { itemRef } from './items';

/*
  Memory (#74, ADR 0006): what Ares has learned and keeps about the User's world, each memory
  remembered with where it came from. Four kinds:

  - rule: a Rule the User keeps (#62), shown in Memory and pointing at the Rule; it is edited only in
    the Rules list, never here.
  - example: what the User's own answers to Ares taught him: a correction or confirmation of his
    filing, a Todo suggestion dismissed or undone.
  - fact: something about People and Projects ("Priya works mostly on TL"). A fact from the User's
    own words is confirmed; one from outside content (a Linear issue) or from where People appear is
    unconfirmed until the User confirms it, and until then only ever background to Ares.
  - preference: how the User likes things, added by hand for now.

  A memory is not an Item: it lives beside the Items, written only through the Item store. Its
  sources are the Items it came from; a fact whose source is deleted (or tombstoned) is flagged for
  review until the User keeps or deletes it.
*/

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();

export const memoryKinds = ['rule', 'example', 'fact', 'preference'] as const;
export const memoryKind = z.enum(memoryKinds);
export type MemoryKind = z.infer<typeof memoryKind>;

// The groups of What Ares knows, in its order.
export const MEMORY_KIND_NAMES: Record<MemoryKind, string> = {
  fact: 'Facts',
  example: 'Examples',
  preference: 'Preferences',
  rule: 'Rules',
};

// One Item a memory came from; `item` is null once Commander no longer holds it at all.
export const memorySource = z.object({ itemId: id, item: itemRef.nullable() });
export type MemorySource = z.infer<typeof memorySource>;

export const memory = z.object({
  id,
  kind: memoryKind,
  // The memory in plain words, as Ares uses it and the User reads (and may edit) it.
  text: z.string(),
  // Confirmed memories are the User's (their words, their answers, or confirmed by them); an
  // unconfirmed one is only ever background to Ares.
  confirmed: z.boolean(),
  // Who it came from: Ares learned it, or the User wrote it (a preference added by hand).
  by: z.enum(['ares', 'user']),
  // What it is about, when it says: a Person and a Project (a People-to-Project fact has both).
  personId: id.nullable(),
  projectId: id.nullable(),
  // A rule memory's Rule.
  ruleId: id.nullable(),
  sources: z.array(memorySource),
  // When it was learned (a rule memory: when its Rule was made), and last changed.
  learnedAt: timestamp,
  updatedAt: timestamp,
  // A fact whose source was deleted since the User last kept it: shown at the top for review, and
  // left out of what Ares uses until the User keeps it.
  forReview: z.boolean(),
});
export type Memory = z.infer<typeof memory>;

// What Ares knows, as its page asks: everything, or the memories whose words match `text`.
export const memoryQuery = z.object({
  text: z.string().max(500).optional(),
});
export type MemoryQuery = z.input<typeof memoryQuery>;

export const whatAresKnows = z.object({
  // Facts flagged for review, newest first.
  forReview: z.array(memory),
  // Every other memory, newest first (the page groups them by kind).
  memories: z.array(memory),
});
export type WhatAresKnows = z.infer<typeof whatAresKnows>;

const memoryText = z
  .string()
  .trim()
  .min(1, 'A memory can’t be empty')
  .max(1000, 'Keep it under 1,000 characters');

// The User's changes to Memory. Editing a memory makes its words the User's, so it is confirmed too.
export const memoryAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add-preference'), text: memoryText }),
  z.object({ type: z.literal('edit'), memoryId: id, text: memoryText }),
  z.object({ type: z.literal('confirm'), memoryId: id }),
  // Keeps a fact flagged for review: it stands, whatever became of its source.
  z.object({ type: z.literal('keep'), memoryId: id }),
  z.object({ type: z.literal('delete'), memoryId: id }),
]);
export type MemoryAction = z.input<typeof memoryAction>;

// What a change left: the memory as it now stands, or null once deleted.
export const memoryChange = z.object({ memory: memory.nullable() });
export type MemoryChange = z.infer<typeof memoryChange>;

// "Learn facts" (#74): Ares picks up facts about People and Projects from Daily Note Blocks and
// Linear issues.
export const LEARN_FACTS = 'learn-facts';
