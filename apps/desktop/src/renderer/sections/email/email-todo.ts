import {
  type ActivityEntry,
  addressName,
  bareSubject,
  type EmailThread,
  type EmailThreadSummary,
  type Filing,
  type Item,
  type ItemAction,
  inheritedFiling,
} from '@commander/domain';
import type { ItemStoreClient } from '../../item-store/client';

/*
  Make it a Todo (#140): a Todo the User makes from an email, with `t` on a thread in the Email
  Section, in Triage or on the Dashboard, or the open thread's button. Its title starts as the
  subject (without "Re:"), edited before it is made; it has origin email, the thread's Project filed
  as inherited, and a made-from Link to the email, so the Todos Section shows it as "From email ·
  Dana Reyes" and its Link opens the thread. The Todo and its Link are made as one change, and
  undone together.
*/

/** The Todo to make: from which email, with what title, under which Project. */
export type EmailTodoDraft = {
  emailId: string;
  title: string;
  filing: Filing;
  /** Who wrote the email, for the dialog and the toast: "Dana Reyes". */
  sender: string;
};

/** What makes it: the Todo and its made-from Link, in that order. */
export function emailTodoActions(draft: EmailTodoDraft, todoId: string): ItemAction[] {
  return [
    {
      type: 'create',
      item: {
        id: todoId,
        kind: 'todo',
        title: draft.title.trim(),
        filing: draft.filing,
        detail: { kind: 'todo', origin: 'email', dueOn: null, backedBy: null },
      },
    },
    { type: 'link', from: todoId, linkType: 'made-from', to: draft.emailId },
  ];
}

const emailOf = (item: Item) => (item.detail?.kind === 'email' ? item.detail : null);

/**
 * The Todo a thread would make: from its latest message someone else wrote (the User's own reply
 * asks nothing of them), else its latest; titled with the subject, under the thread's Project (its
 * Badge, the latest message's), as inherited.
 */
export function emailTodoDraft(
  thread: Pick<EmailThreadSummary, 'subject' | 'latest'>,
  messages?: EmailThread['messages'],
): EmailTodoDraft {
  const received = (messages ?? []).filter(({ item }) => !emailOf(item)?.sentByMe).at(-1)?.item;
  const email = received ?? thread.latest;
  const detail = emailOf(email);
  return {
    emailId: email.id,
    title: bareSubject(thread.subject || detail?.subject || email.title),
    filing: inheritedFiling(thread.latest.filing),
    sender: detail ? (detail.sentByMe ? 'me' : addressName(detail.from)) : '',
  };
}

/** The Todo an email Item would make (a Dashboard row, which is one message). */
export const emailItemTodoDraft = (email: Item): EmailTodoDraft =>
  emailTodoDraft({ subject: emailOf(email)?.subject ?? email.title, latest: email });

/** Makes the Todo, as the User. Resolves with the change's entries (the Todo's creation first). */
export async function makeEmailTodo(
  itemStore: ItemStoreClient,
  draft: EmailTodoDraft,
  newId: () => string = () => crypto.randomUUID(),
): Promise<ActivityEntry[]> {
  if (!draft.title.trim()) throw new Error('A Todo can’t be empty');
  return itemStore({ op: 'record-all', actions: emailTodoActions(draft, newId()) });
}
