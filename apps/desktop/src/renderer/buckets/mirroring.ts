import type { BucketMirroring, BucketMirroringChange, MirrorSource } from '@commander/domain';
import type { AccountsResponse } from '@commander/domain/ipc';
import type { ItemStoreClient } from '../item-store/client';

/*
  Mirror Buckets (#142), as the window reaches it: each email Account's switch, kept by the Core's
  Item store (off unless the User switches it on), and, for Outlook, Grant access for the categories'
  permission (MailboxSettings.ReadWrite), a Microsoft sign-in again through Settings → Accounts' bridge.
*/

export interface MirroringClient {
  /** Every Account's switch (an Account never switched on isn't listed: off). */
  list(): Promise<BucketMirroring[]>;
  /** Switches mirroring on or off for an Account (removing Commander's labels if asked). */
  set(change: BucketMirroringChange & { source: MirrorSource }): Promise<BucketMirroring>;
  /** Outlook: signs in again asking for MailboxSettings.ReadWrite too. */
  grant(accountId: string): Promise<AccountsResponse>;
}

export function mirroringIn(
  itemStore: ItemStoreClient,
  grant: (accountId: string) => Promise<AccountsResponse>,
): MirroringClient {
  return {
    list: () => itemStore({ op: 'bucket-mirroring' }),
    set: (change) => itemStore({ op: 'set-bucket-mirroring', change }),
    grant,
  };
}

/** The window's own: the Core's Item store, and Settings → Accounts' bridge for Grant access. */
export const windowMirroring = (): MirroringClient =>
  mirroringIn(
    (request) => window.commander.itemStore(request),
    (accountId) => window.commander.accounts({ op: 'grant-mailbox-settings', accountId }),
  );
