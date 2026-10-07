/*
  A reply handed from a Conversation to where it is written (#198): Open in composer under one of
  Ares's answers opens the email thread or the Chat in its Section (frame/reveal.ts, with one of the
  focuses below) and that Section puts the reply where the User writes, for them to edit and send.
  Nothing is sent from here.

  - SUGGESTED_REPLY_FOCUS: the Email Section opens the thread's suggested reply in the composer, as its
    own Open in composer does (an ordinary Draft, #143).
  - ARES_REPLY_FOCUS: the Section takes the text handed over here (a Chat's draft, or a reply holding
    the booking link) and puts it in the composer or the Chat's reply box.
*/

export const SUGGESTED_REPLY_FOCUS = 'suggested-reply';
export const ARES_REPLY_FOCUS = 'ares-reply';

/** A reply handed over: its text, and the booking link it ends with, when it is one. */
export type HandedReply = { text: string; link?: string };

// The replies waiting for each Item's Section to take them, by the Item's id.
const handed = new Map<string, HandedReply>();

/** Hands a reply over for the Item's Section to take when it opens it (ARES_REPLY_FOCUS). */
export function handReply(itemId: string, reply: HandedReply): void {
  handed.set(itemId, reply);
}

/** The reply handed over for an Item, once: null when there is none. */
export function takeReply(itemId: string): HandedReply | null {
  const reply = handed.get(itemId) ?? null;
  handed.delete(itemId);
  return reply;
}
