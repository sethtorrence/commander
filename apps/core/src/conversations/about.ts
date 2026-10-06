// The Item a Conversation is about (#193, decision #24). The Ares button on an Item starts a new
// Conversation from it, and that Item is handed to Ares with every message the User sends there, read
// afresh each time (its facts and words, as a Skill reads an Item), with the ref I1. Its data block's
// trust comes from where it came from, as every Item's does (safety/trust.ts): an email, an issue or a
// Chat is outside material in a block of its own; a Todo the User wrote, or a Block of theirs, is the
// User's. The same limits as the Skills: no Gmail mail before the User allowed Ares to read it, and
// nothing once the Item has gone. What Commander tells him about it is in its own words.
import { ABOUT_REF, type ConversationAbout, type Item, mayReadMail } from '@commander/domain';
import type { ItemStore } from '../item-store';
import { type FoundItem, findable } from '../skills/findings';
import { readItem } from '../skills/read-item';
import { labelOf, sectionOf } from '../updates/kinds/words';

/** What Ares is handed of the Item a Conversation is about: the Item read, or why not, in a note. */
export type AboutReading = { found: FoundItem | null; note: string };

export const ABOUT_NOTES = {
  handed: `The User started this Conversation from one Item, handed to you as ${ABOUT_REF}: when they say “this” or “it”, they mean ${ABOUT_REF}. You don’t need a Skill to read it. Summarise on ${ABOUT_REF} gathers the rest of its email thread or Chat, if that is wanted.`,
  gone: 'The User started this Conversation from an Item that is no longer in Commander, so it can’t be shown to you. If they ask about it, say so plainly.',
  own: 'The User started this Conversation from something of your own (a meeting’s prep or a GitHub summary), which isn’t handed to you here. If they ask about it, say so plainly.',
  mail: 'The User started this Conversation from an email in an Account whose mail you may not read yet: they haven’t allowed it. If they ask about it, say plainly that you can’t read it until they allow it in the Email Section.',
} as const;

/** The Item as the window names it: its title, its Source's short name, and the Section it opens in. */
export function aboutOf(item: Item): ConversationAbout {
  return {
    itemId: item.id,
    kind: item.kind,
    title: item.title,
    label: labelOf(item),
    section: sectionOf(item),
  };
}

/** Reads the Item a Conversation is about, for each message, as Ares may see it. */
export function createAboutReader({
  itemStore,
}: {
  itemStore: Pick<ItemStore, 'get' | 'models' | 'projects' | 'emailBody'>;
}): (itemId: string) => AboutReading {
  const mayRead = (item: Item) => mayReadMail(itemStore.models.settings(), item.source, item.account);
  const projectCode = (projectId: string) =>
    itemStore.projects({ includeArchived: true }).find((project) => project.id === projectId)?.code ?? null;
  const emailText = (itemId: string) => itemStore.emailBody(itemId)?.text ?? null;
  return (itemId) => {
    const item = itemStore.get(itemId)?.item;
    if (!item || item.deletedAt !== null) return { found: null, note: ABOUT_NOTES.gone };
    if (!mayRead(item)) return { found: null, note: ABOUT_NOTES.mail };
    if (!findable(item, mayRead)) return { found: null, note: ABOUT_NOTES.own };
    return { found: { item, text: readItem(item, { emailText, projectCode }) }, note: ABOUT_NOTES.handed };
  };
}
