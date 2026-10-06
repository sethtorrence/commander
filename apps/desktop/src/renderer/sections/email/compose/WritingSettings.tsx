import { type EmailComposeSettings, UNDO_SEND_CHOICES } from '@commander/domain';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from '@commander/ui';
import { useEffect, useState } from 'react';
import { SettingRow } from '../../../settings/parts';
import type { ComposeClient } from './compose';

/*
  Settings → Email's writing settings (#138): the Account new mail goes from (changeable in each
  message), and how long every send is held with Undo before it really goes: 5, 10, 20, 30 or 60
  seconds (10 unless changed). Kept by the Core, which holds the sends.
*/

const FIRST = 'first';

export function WritingSettings({
  client,
  accounts,
  shown = true,
}: {
  client: ComposeClient;
  /** The email Accounts, by id, with the name each goes by. */
  accounts: { account: string; name: string | null }[];
  shown?: boolean;
}) {
  const [settings, setSettings] = useState<EmailComposeSettings | null>(null);
  useEffect(() => {
    if (!shown) return;
    client.settings().then(setSettings, () => setSettings(null));
  }, [client, shown]);

  const save = async (next: EmailComposeSettings) => {
    setSettings(next);
    try {
      setSettings(await client.saveSettings(next));
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  };

  if (!settings) return null;
  const chosen = accounts.some((each) => each.account === settings.defaultAccount)
    ? (settings.defaultAccount as string)
    : FIRST;
  return (
    <>
      <SettingRow
        label="New mail from"
        description="The Account a new message starts from. Replies and forwards go from the Account the message arrived at."
      >
        <Select
          value={chosen}
          onValueChange={(value) =>
            void save({ ...settings, defaultAccount: value === FIRST ? null : value })
          }
        >
          <SelectTrigger aria-label="New mail from" className="w-[260px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FIRST}>The first email Account</SelectItem>
            {accounts.map((each) => (
              <SelectItem key={each.account} value={each.account}>
                {each.name ?? each.account}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        label="Undo send"
        description="Every message waits this long, with Undo, before it really goes. Closing the window keeps the wait; quitting sends it first."
      >
        <Select
          value={String(settings.undoSeconds)}
          onValueChange={(value) => {
            const seconds = UNDO_SEND_CHOICES.find((each) => String(each) === value);
            if (seconds) void save({ ...settings, undoSeconds: seconds });
          }}
        >
          <SelectTrigger aria-label="Undo send" className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {UNDO_SEND_CHOICES.map((seconds) => (
              <SelectItem key={seconds} value={String(seconds)}>
                {seconds} seconds
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
    </>
  );
}
