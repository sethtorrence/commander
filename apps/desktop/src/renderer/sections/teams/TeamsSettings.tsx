import type { ChatSetting, ChatSettingAction } from '@commander/domain';
import { Button, toast } from '@commander/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SettingsGroup } from '../../settings/parts';
import { whenShort } from '../todos/when';
import { ChannelPostsSettings } from './ChannelPostsSettings';
import { type ChannelPostsClient, channelPostsIn } from './channel-posts';
import { type TeamsChats, teamsChatsIn } from './teams-chats';

const pad = (n: number) => String(n).padStart(2, '0');

const rowClass =
  'grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 border-b border-line2 py-2 pr-6 pl-13';

function SettingList({
  label,
  settings,
  note,
  action,
  onAction,
}: {
  label: string;
  settings: ChatSetting[];
  note: (setting: ChatSetting) => string;
  action: (setting: ChatSetting) => { label: string; name: string };
  onAction: (setting: ChatSetting) => void;
}) {
  if (!settings.length) return null;
  return (
    <section aria-label={label}>
      <h3 className="m-0 border-b border-line2 py-2 pr-6 pl-13 font-mono text-label leading-none font-semibold uppercase tracking-caps text-muted">
        {label} · {pad(settings.length)}
      </h3>
      <ul className="m-0 list-none p-0">
        {settings.map((setting) => {
          const { label: words, name } = action(setting);
          return (
            <li key={`${setting.account}\n${setting.chatId}`} className={rowClass}>
              <span className="min-w-0 truncate text-row text-ink">{setting.name}</span>
              <span className="font-mono text-label-lg whitespace-nowrap text-muted">{note(setting)}</span>
              <Button aria-label={name} onClick={() => onAction(setting)}>
                {words}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Settings → Teams: Channel posts (#111, ChannelPostsSettings), then the Chats the User muted
 * (Unmute) or excluded from Commander (Include again, which asks the Account for a light sync so the
 * Chat comes back at once). Mute and exclude are Commander settings only: nothing changes in Teams.
 * `shown` while Settings is on screen: the lists are read again each time it comes back, for Chats
 * muted or excluded in the Teams Section meanwhile.
 */
export function TeamsSettings({
  no,
  shown = true,
  chats: given,
  channelPosts: givenChannelPosts,
  syncNow = async (accountId) => {
    await window.commander.accounts({ op: 'sync-now', accountId });
  },
}: {
  no: string;
  shown?: boolean;
  chats?: TeamsChats;
  /** Channel posts (#111); without it (and without the window's bridge), none show. */
  channelPosts?: ChannelPostsClient;
  syncNow?: (accountId: string) => Promise<void>;
}) {
  const chats = useMemo(() => given ?? teamsChatsIn(window.commander.itemStore), [given]);
  const channelPosts = useMemo(
    () =>
      givenChannelPosts ??
      ('onAccountsChanged' in (window.commander ?? {})
        ? channelPostsIn(window.commander, window.commander.itemStore)
        : null),
    [givenChannelPosts],
  );
  const [settings, setSettings] = useState<ChatSetting[] | null>(null);

  const reload = useCallback(() => {
    chats.settings().then(setSettings, report);
  }, [chats]);
  const wasShown = useRef(false);
  useEffect(() => {
    if (shown && !wasShown.current) reload();
    wasShown.current = shown;
  }, [shown, reload]);

  const change = async (setting: ChatSetting, kind: ChatSettingAction['change']) => {
    try {
      await chats.change({ account: setting.account, chatId: setting.chatId, change: kind });
      if (kind === 'include') {
        toast(`Included again: ${setting.name}. It comes back with the next check.`);
        await syncNow(setting.account);
      }
    } catch (error) {
      report(error);
    }
    reload();
  };

  const excluded = (settings ?? []).filter((setting) => setting.excludedAt !== null);
  const muted = (settings ?? []).filter((setting) => setting.muted && setting.excludedAt === null);

  return (
    <SettingsGroup
      no={no}
      title="Teams"
      note="Channel posts, muted and excluded chats · nothing changes in Teams"
    >
      {channelPosts && <ChannelPostsSettings client={channelPosts} shown={shown} />}
      {settings && !excluded.length && !muted.length && (
        <p className="hatch m-0 border-b border-line2 py-3 pr-5 pl-13 text-heading text-faint">
          No muted or excluded chats. Mute or exclude one from its Chat view in the Teams Section.
        </p>
      )}
      <SettingList
        label="Excluded chats"
        settings={excluded}
        note={(setting) => `Excluded ${whenShort(setting.excludedAt ?? setting.updatedAt)} · not synced`}
        action={(setting) => ({ label: 'Include again', name: `Include ${setting.name} again` })}
        onAction={(setting) => void change(setting, 'include')}
      />
      <SettingList
        label="Muted chats"
        settings={muted}
        note={() => 'Synced, not counted as unread'}
        action={(setting) => ({ label: 'Unmute', name: `Unmute ${setting.name}` })}
        onAction={(setting) => void change(setting, 'unmute')}
      />
    </SettingsGroup>
  );
}

function report(error: unknown) {
  toast(error instanceof Error ? error.message : String(error));
}
