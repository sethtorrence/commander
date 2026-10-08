import { z } from 'zod';
import { lineActionName } from './conversation-made';
import { LINK_REF } from './conversations';
import type { SkillInfo } from './skills';
import { snoozeChoice } from './updates';

/*
  Replying to an Update line (#236, decision #24): every line of an Update has a Reply box, and what the
  User types there starts a Conversation about that line (or carries on the one it has), with their
  words as its first message. With every message Ares is handed the line's facts in Commander's own
  words and each of its Items in a block of its own by where it came from, read afresh, and he can
  propose the line's own actions (conversation-made.ts) as cards the User confirms with one key,
  besides using his other Skills. What the User says there is context for that one line only: none of
  it becomes Memory.
*/

/** What the Update line Skill is given: one of the line's actions, on the line or one of its Items. */
export const lineSkillInput = z.object({
  action: lineActionName,
  // One of the line's Items, by the ref he was handed it by: the action is that Item's own.
  item: z.string().trim().regex(LINK_REF, 'name an Item by the ref you were given, as "I1"').optional(),
  // For snooze: until when.
  until: snoozeChoice.optional(),
});
export type LineSkillInput = z.infer<typeof lineSkillInput>;

export const LINE_SKILL_NEEDS =
  '{"action": one of "done", "dismiss", "snooze", "open", "accept", "retry" on the whole line, or one of "open", "reply", "accept", "dismiss", "tick", "not-an-instruction", "edit", "retry" on one of its Items; "item": that Item’s ref, only when the action is on one of its Items; "until": "later-today" or "tomorrow", only for snooze}';

// The Update line (#236): the line a Conversation is about, acted on as its own buttons would.
export const LINE_SKILL: SkillInfo = {
  name: 'line',
  title: 'Act on the Update line',
  description:
    'Prepare one of the actions the Update line this Conversation is about offers (Done, Dismiss, Snooze, Open, Accept, Retry, or one of its Items’ own, as Commander lists them for the line), as a card the User confirms with one key; it does exactly what the line’s button does. Only in a Conversation about an Update line, and only when the User asks for it ("Dana’s handling this, dismiss it", "remind me tomorrow").',
  summary:
    'In a Conversation about an Update line: prepares the line’s own actions for you to confirm, as its buttons would.',
  example: 'Dana’s handling this now, dismiss it',
  acts: true,
};
