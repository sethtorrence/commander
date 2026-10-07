import { z } from 'zod';
import type { AresActivity } from './autonomy';
import type { Item } from './items';
import type { SkillInfo } from './skills';
import { MESSAGE_FIELD } from './synced-fields';
import { type ChatReply, chatReply, MAX_REPLY_LENGTH } from './teams';

/*
  Ares turns Chats into work and words (#110): what the window and the Core share about it.

  - "Suggest Todos from Teams" (a Quick job, after each Teams sync) reads the new messages in unmuted
    Chats, one Chat per call, and proposes a Todo for each request made of the User and each promise
    the User made, under the "Suggest Todos" action (Organise) in the Teams Section. The Todo has
    origin Ares, a made-from Link to the Chat, the Chat's Project (inherited), and `fromMessage`, so
    its Link opens the Chat at that message. At Ask it waits as a card beside the message.
  - Draft (a Deep call, on request): Ares writes a reply from the Chat's recent messages, which goes
    in the reply box for the User to edit and send. It changes nothing (Organise, "Draft replies").
  - "Suggest Teams replies" (a Deep job): a Chat flagged waiting on the User (#109) gets one suggested
    reply per flag, an Act for you / "Reply in Teams" suggestion: capped at Ask, accepted one at a
    time, and sent only when the User presses Send. Its one step is the reply the User would write
    (the Chat's synced field `message:<clientId>`), carried out as the User, so it goes through the
    same outgoing queue as any reply. The Item store refuses a reply from Ares himself.
*/

/** The job that suggests Todos from Chats. Its proposals go under the "Suggest Todos" action. */
export const SUGGEST_TODOS_FROM_TEAMS = 'suggest-todos-from-teams';
/** The Draft call, on request, as the Usage page lists it. */
export const DRAFT_REPLY = 'draft-reply';
/** The Organise action Draft runs under: Off in Settings, Draft offers nothing. */
export const DRAFT_REPLIES = 'draft-replies';
/** The job that prepares a suggested reply for each Chat waiting on the User. */
export const SUGGEST_TEAMS_REPLIES = 'suggest-teams-replies';
/** The Act for you action a suggested reply goes under: never above Ask. */
export const REPLY_IN_TEAMS = 'reply-in-teams';

/** A draft Ares wrote for a Chat, on request: the User's to edit and send, or not. */
export const chatDraft = z.object({
  itemId: z.string().min(1),
  text: z.string().min(1).max(MAX_REPLY_LENGTH),
  at: z.number().int().nonnegative(),
});
export type ChatDraft = z.infer<typeof chatDraft>;

/** Draft: one of Ares's Skills, on a Chat or an email thread (#143), and in Conversations (#198). */
export const DRAFT_SKILL: SkillInfo = {
  name: 'draft',
  description:
    'Draft the User’s reply to an email thread or a Teams Chat, in their own style, from its recent messages and what the User asked it to say ("reply to this saying Thursday works", "draft a reply to Priya’s last Chat"). Find the email or Chat first and give its ref. The draft shows under your answer for the User to open in the composer, edit and send themselves: you never send anything.',
  title: 'Draft',
  summary:
    'Drafts a reply to an email or a Teams Chat in your own style, for you to open in the composer, edit and send yourself.',
  example: 'Reply to this saying Thursday works',
};

/** Where a Todo Ares made from a Chat came from: the Chat, and the message it opens at. */
export type TodoFromMessage = { itemId: string; messageId: string };

/** The Chat message a Todo was made from, if Ares made it from one. */
export function fromMessageOf(todo: Pick<Item, 'detail'> | null | undefined): TodoFromMessage | null {
  return todo?.detail?.kind === 'todo' ? (todo.detail.fromMessage ?? null) : null;
}

/** A pending "Suggest Todos" suggestion on a Chat, as its card beside the message shows it. */
export type ChatTodoSuggestion = {
  proposalId: number;
  chatId: string;
  messageId: string;
  title: string;
  dueOn: string | null;
  reason: string;
};

/** A pending suggestion as a Todo card in the Chat view, or null for anything else. */
export function chatTodoSuggestionOf(row: AresActivity): ChatTodoSuggestion | null {
  if (row.status !== 'pending' || row.item?.kind !== 'chat') return null;
  const create = row.itemActions.find((step) => step.type === 'create' && step.item.kind === 'todo');
  if (create?.type !== 'create' || create.item.detail?.kind !== 'todo') return null;
  const from = create.item.detail.fromMessage;
  if (!from) return null;
  return {
    proposalId: row.id,
    chatId: row.itemId,
    messageId: from.messageId,
    title: create.item.title,
    dueOn: create.item.detail.dueOn,
    reason: row.reason,
  };
}

/** A pending "Reply in Teams" suggestion, as its card above the reply box shows it. */
export type ChatReplySuggestion = { proposalId: number; chatId: string; reply: ChatReply; reason: string };

/** A pending suggestion as a suggested reply, or null for anything else. */
export function chatReplySuggestionOf(row: AresActivity): ChatReplySuggestion | null {
  if (row.status !== 'pending' || row.action !== REPLY_IN_TEAMS) return null;
  for (const step of row.itemActions) {
    if (step.type !== 'edit-fields') continue;
    for (const [field, value] of Object.entries(step.fields)) {
      if (!field.startsWith(MESSAGE_FIELD)) continue;
      const reply = chatReply.safeParse(value);
      if (reply.success)
        return { proposalId: row.id, chatId: row.itemId, reply: reply.data, reason: row.reason };
    }
  }
  return null;
}
