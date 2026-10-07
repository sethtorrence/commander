// Snooze (#196): the User tells Ares to snooze an email thread until a time, from a Conversation
// ("snooze this until Monday"), with Commander's own Snooze (#135): every message of the thread gets
// the `snooze` field, as the Email Section's snooze does, so the thread leaves the inbox for Snoozed
// and comes back to the top of it, unread, at that time. The field is Commander's own and never
// reaches Gmail or Outlook, so snoozing is Organise, in the Email Section. The time is the one the
// User's words mean on their own clock ("monday" is Monday 08:00), and must be still to come.
import {
  CONVERSATION_SNOOZE,
  type EmailDetail,
  type RegisteredAction,
  type Skill,
  SNOOZE_NEEDS,
  SNOOZE_SKILL,
  type SnoozeInput,
  snoozeInput,
  snoozeUntilFrom,
  threadActionFields,
} from '@commander/domain';
import { type Acted, type ActionSkillOptions, acting, actionFindings, registerActions } from './act';
import type { Findings } from './findings';

export const SNOOZE_ACTION: RegisteredAction = {
  action: CONVERSATION_SNOOZE,
  actionKind: 'organise',
  name: 'Snooze',
  hint: 'Email threads Ares snoozes when you tell him to in a Conversation (Commander’s own Snooze)',
};

/** A time as the User reads it: "Monday 12 October, 08:00". */
export function timeWords(at: number): string {
  const date = new Date(at);
  const day = date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  return `${day}, ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function createSnoozeSkill(options: ActionSkillOptions): Skill<SnoozeInput, Findings> {
  const { itemStore, gate } = options;
  const now = options.now ?? Date.now;
  registerActions(gate, SNOOZE_ACTION);
  const title = SNOOZE_SKILL.title as string;

  return {
    ...SNOOZE_SKILL,
    input: { schema: snoozeInput, describe: SNOOZE_NEEDS },
    async run(input, context) {
      const act = acting(context ?? {}, options);
      const until = snoozeUntilFrom(input.until, now());
      if (until === null) return actionFindings(title, [], ['snoozing: that time has already passed']);
      const acted: Acted[] = [];
      const skipped: string[] = [];
      const threads = new Set<string>();
      for (const ref of new Set(input.items)) {
        const item = act.item(ref);
        const detail = item.detail?.kind === 'email' ? item.detail : null;
        if (!detail || !item.account) {
          skipped.push(`${ref} isn’t an email`);
          continue;
        }
        const key = `${item.account}\u0000${detail.threadKey}`;
        if (threads.has(key)) continue;
        threads.add(key);
        // The thread's messages as they are now; never a draft (only the User touches those).
        const messages = (itemStore.emailThread(item.account, detail.threadKey)?.messages ?? []).flatMap(
          ({ item: message }) =>
            message.detail?.kind === 'email' && !message.detail.draft && message.deletedAt === null
              ? [{ id: message.id, detail: message.detail as EmailDetail }]
              : [],
        );
        const changes = threadActionFields({ type: 'snooze', until }, messages);
        if (!changes.length) {
          skipped.push(`${ref}’s thread is already snoozed until then`);
          continue;
        }
        const latest = [...messages].sort((a, b) => b.detail.sentAt - a.detail.sentAt)[0];
        acted.push(
          act.propose({
            what: `snooze ${ref}’s thread until ${timeWords(until)}`,
            proposal: {
              actionKind: 'organise',
              action: CONVERSATION_SNOOZE,
              section: 'email',
              itemId: latest?.id ?? item.id,
              itemActions: changes.map(({ itemId, fields }) => ({
                type: 'edit-fields' as const,
                itemId,
                fields,
              })),
            },
          }),
        );
      }
      return actionFindings(title, acted, skipped);
    },
  };
}
