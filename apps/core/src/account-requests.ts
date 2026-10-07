// Account requests from the main process: when the User removes an Account, its Items go too.
import { type CoreRemoveAccountItemsReply, coreRemoveAccountItems, type Source } from '@commander/domain';
import { z } from 'zod';
import type { ItemStore } from './item-store';

const envelope = z.object({ type: z.literal('remove-account-items'), id: z.number().int().positive() });

const sourceNames: Record<Source, string> = {
  gmail: 'Gmail',
  outlook: 'Outlook',
  'google-calendar': 'Google Calendar',
  'outlook-calendar': 'Outlook Calendar',
  teams: 'Teams',
  linear: 'Linear',
  github: 'GitHub',
};

// Returns the reply to send back, or null when the message is not a remove-account-items request.
// `beforeRemove` runs first, so the Account's syncing stops before its Items go; `afterRemove` once
// they have (the files only they needed can go then).
export function answerRemoveAccountItems(
  store: ItemStore,
  message: unknown,
  beforeRemove: (account: string) => void = () => {},
  afterRemove: (account: string) => void = () => {},
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
    beforeRemove(account);
    const removed = store.removeAccountItems(
      { source, account },
      { by: { kind: 'user' }, why: `Removed the ${sourceNames[source]} Account ${name}` },
    );
    // What a GitHub Account watched goes with it.
    if (source === 'github') store.githubWatch.forget(account);
    afterRemove(account);
    return reply({ ok: true, removed: removed.length });
  } catch (error) {
    return reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
