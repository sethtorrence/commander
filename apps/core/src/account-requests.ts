// Account requests from the main process: when the User removes an Account, its Items go too.
import { type CoreRemoveAccountItemsReply, coreRemoveAccountItems, type Source } from '@commander/domain';
import { z } from 'zod';
import type { ItemStore } from './item-store';

const envelope = z.object({ type: z.literal('remove-account-items'), id: z.number().int().positive() });

const sourceNames: Record<Source, string> = {
  gmail: 'Gmail',
  outlook: 'Outlook',
  'google-calendar': 'Google Calendar',
  teams: 'Teams',
  linear: 'Linear',
  github: 'GitHub',
};

// Returns the reply to send back, or null when the message is not a remove-account-items request.
export function answerRemoveAccountItems(
  store: ItemStore,
  message: unknown,
): CoreRemoveAccountItemsReply | null {
  const header = envelope.safeParse(message);
  if (!header.success) return null;
  const reply = (response: CoreRemoveAccountItemsReply['response']): CoreRemoveAccountItemsReply => ({
    type: 'remove-account-items-reply',
    id: header.data.id,
    response,
  });
  const parsed = coreRemoveAccountItems.safeParse(message);
  if (!parsed.success) return reply({ ok: false, error: `Malformed request: ${parsed.error.message}` });
  const { source, account, name } = parsed.data;
  try {
    const removed = store.removeAccountItems(
      { source, account },
      { by: { kind: 'user' }, why: `Removed the ${sourceNames[source]} Account ${name}` },
    );
    return reply({ ok: true, removed: removed.length });
  } catch (error) {
    return reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
