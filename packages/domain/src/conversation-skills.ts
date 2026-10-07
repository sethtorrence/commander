import { z } from 'zod';
import { LINK_REF } from './conversations';
import type { SkillInfo } from './skills';

/*
  Draft and Meeting prep in a Conversation (#198, decision #24): Skills that make something for his
  answer to show (conversation-made.ts) rather than act. What the model gives them names Items only by
  the refs handed to him for this answer (I1, I2…). What a draft should say is never his words: it is
  the User's own message, which Commander hands the draft as theirs.
*/

// An Item he was handed for this answer, by its ref.
const ref = z.string().trim().regex(LINK_REF, 'name an Item by the ref you were given, as "I1"');

// ---------------------------------------------------------------------------------------------
// Draft

/** What Draft is given in a Conversation: the email or Chat to reply to. */
export const draftInput = z.object({ item: ref });
export type DraftInput = z.infer<typeof draftInput>;

export const DRAFT_NEEDS = '{"item": the ref of the email or Teams Chat to reply to}';

// ---------------------------------------------------------------------------------------------
// Meeting prep

export const meetingPrepInput = z.object({ event: ref });
export type MeetingPrepInput = z.infer<typeof meetingPrepInput>;

export const MEETING_PREP_NEEDS = '{"event": the ref of the calendar event}';

// Meeting prep (#130, #198): Ares prepares the User for a meeting they name.
export const MEETING_PREP_SKILL: SkillInfo = {
  name: 'prep',
  title: 'Meeting prep',
  description:
    'Prepare the User for one of their meetings: what it is about, what was said last time, what is open with the people in it and what is worth raising ("prep me for the 2pm", "what do I need for the Acme call?"). Find the event first and give its ref. The prep shows under your answer, linked to the event.',
  summary: 'Prepares you for a meeting: what it’s about, last time, what’s open and what to raise.',
  example: 'Prep me for the 2pm',
};
