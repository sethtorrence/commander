import type { EmailImageAccount } from '@commander/domain';
import { Button, Switch, toast } from '@commander/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SettingRow, SettingsGroup } from '../../settings/parts';
import { type EmailReaderClient, emailReaderIn } from './reader';

/**
 * Settings → Email (#134): each email Account's remote images. A Gmail Account shows them, as Gmail
 * does, unless Ask before showing images is on; an Outlook Account holds them back unless the sender
 * is trusted. Trusted senders (Always show from this sender) are listed per Account, each removable.
 * `shown` while Settings is on screen: read again each time it comes back.
 */
export function EmailSettings({
  no,
  shown = true,
  reader: given,
  onAccountsChanged = (listener) => window.commander.onAccountsChanged(listener),
}: {
  no: string;
  shown?: boolean;
  reader?: EmailReaderClient;
  /** Accounts connected or removed (Settings → Accounts): the list is read again. */
  onAccountsChanged?: (listener: () => void) => () => void;
}) {
  const reader = useMemo(() => given ?? emailReaderIn(window.commander), [given]);
  const [accounts, setAccounts] = useState<EmailImageAccount[] | null>(null);
  const reload = useCallback(() => {
    reader.imageSettings().then(setAccounts, (error: unknown) => toast(String(error)));
  }, [reader]);
  const subscribe = useRef(onAccountsChanged);
  useEffect(() => subscribe.current(reload), [reload]);
  const wasShown = useRef(false);
  useEffect(() => {
    if (shown && !wasShown.current) reload();
    wasShown.current = shown;
  }, [shown, reload]);

  const change = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
    reload();
  };

  if (!accounts?.length) return null;
  return (
    <SettingsGroup no={no} title="Email" note="Remote images" data-testid="email-settings">
      {accounts.map((account) => (
        <section key={account.account} aria-label={account.name ?? account.account}>
          {account.source === 'gmail' && (
            <SettingRow
              label={`Ask before showing images · ${account.name ?? account.account}`}
              description="Gmail shows remote images through Google’s proxy. Commander can’t, so it loads them directly: senders may see when you opened an email and your approximate location. On: images wait until you choose Show images."
            >
              <Switch
                aria-label={`Ask before showing images for ${account.name ?? account.account}`}
                checked={account.askFirst}
                onCheckedChange={(on) => void change(() => reader.setAskFirst(account.account, on))}
              />
            </SettingRow>
          )}
          <SettingRow
            label={`Always show images from · ${account.name ?? account.account}`}
            description={
              account.source === 'outlook'
                ? 'Outlook Accounts hold images back unless you trust the sender.'
                : 'Senders whose images show even when Commander asks first.'
            }
          >
            {account.trustedSenders.length ? (
              <ul className="m-0 list-none p-0">
                {account.trustedSenders.map((address) => (
                  <li key={address} data-testid="trusted-sender" className="flex items-center gap-3 py-1">
                    <span className="min-w-0 flex-1 truncate font-mono text-label-lg text-ink">
                      {address}
                    </span>
                    <Button
                      aria-label={`Stop always showing images from ${address}`}
                      onClick={() => void change(() => reader.untrustSender(account.account, address))}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-note text-faint">No one yet.</span>
            )}
          </SettingRow>
        </section>
      ))}
    </SettingsGroup>
  );
}
