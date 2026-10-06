import { CHANNEL_READ_PERMISSION, type ChannelChoices, type ChannelSettingAction } from '@commander/domain';
import type { AdminConsentNeeded, TeamsAccountSummary } from '@commander/domain/ipc';
import { Button, Switch, toast } from '@commander/ui';
import { useCallback, useEffect, useState } from 'react';
import { AdminConsent } from '../../settings/AccountsPanel';
import type { ChannelPostsClient } from './channel-posts';

/*
  Settings → Teams → Channel posts (#111), per Teams Account. Until the Account's sign-in carries
  ChannelMessage.Read.All, it says in one line what Channel posts need, names the permissions, shows
  the steps for an administrator with the admin consent link to copy, and offers Request access (a
  Microsoft sign-in again, asking for the Channel post permissions too). Once granted, the switch
  Sync Channel posts (off until the User turns it on); with it on, the Account's teams and channels,
  every one synced unless excluded, alone or with its team. Nothing else about channels shows anywhere
  until then.
*/

type Problem = { accountId: string; message: string; adminConsent?: AdminConsentNeeded };

const row = 'flex min-h-8 items-center gap-3 border-b border-line2 py-1.5 pr-6';

function Steps({ permissions }: { permissions: readonly string[] }) {
  return (
    <ol data-testid="channel-posts-steps" className="m-0 mt-2 pl-5 text-note leading-[19px] text-muted">
      <li>
        In the Microsoft Entra admin center: App registrations → Commander → API permissions → Add a
        permission → Microsoft Graph → Delegated: add {permissions.join(' and ')}.
      </li>
      <li>
        Choose Grant admin consent for your organisation (or send the admin consent link below to an
        administrator).
      </li>
      <li>Then choose Request access here, and switch on Sync Channel posts.</li>
    </ol>
  );
}

function ChannelChoicesList({
  choices,
  onChange,
}: {
  choices: ChannelChoices | null;
  onChange: (action: Omit<ChannelSettingAction, 'account'>) => void;
}) {
  if (!choices || choices.teams.length === 0)
    return (
      <p className="m-0 border-b border-line2 py-2 text-note text-faint">
        Your teams and channels show here after the next check of Teams.
      </p>
    );
  return (
    <ul aria-label="Teams and channels" className="m-0 list-none p-0">
      {choices.teams.map((team) => (
        <li key={team.id}>
          <div className={row}>
            <span className="min-w-0 flex-1 truncate text-row font-semibold text-ink">{team.name}</span>
            <span className="font-mono text-label-lg text-muted">
              {team.excluded ? 'Excluded' : 'Synced'}
            </span>
            <Button
              aria-label={`${team.excluded ? 'Include' : 'Exclude'} ${team.name}`}
              onClick={() =>
                onChange({ teamId: team.id, channelId: null, change: team.excluded ? 'include' : 'exclude' })
              }
            >
              {team.excluded ? 'Include' : 'Exclude'}
            </Button>
          </div>
          <ul className="m-0 list-none p-0 pl-6">
            {team.channels.map((channel) => {
              const byTeam = team.excluded;
              return (
                <li key={channel.id} className={row}>
                  <span className="min-w-0 flex-1 truncate text-row text-ink">{channel.name}</span>
                  <span className="font-mono text-label-lg text-muted">
                    {channel.excluded ? (byTeam ? 'Excluded with its team' : 'Excluded') : 'Synced'}
                  </span>
                  {!byTeam && (
                    <Button
                      aria-label={`${channel.excluded ? 'Include' : 'Exclude'} ${team.name} / ${channel.name}`}
                      onClick={() =>
                        onChange({
                          teamId: team.id,
                          channelId: channel.id,
                          change: channel.excluded ? 'include' : 'exclude',
                        })
                      }
                    >
                      {channel.excluded ? 'Include' : 'Exclude'}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function AccountChannelPosts({
  account,
  several,
  choices,
  problem,
  busy,
  onRequest,
  onEnabled,
  onChange,
}: {
  account: TeamsAccountSummary;
  several: boolean;
  choices: ChannelChoices | null;
  problem: Problem | null;
  busy: boolean;
  onRequest: () => void;
  onEnabled: (enabled: boolean) => void;
  onChange: (action: Omit<ChannelSettingAction, 'account'>) => void;
}) {
  const access = account.channelPosts;
  const permissions = access?.permissions ?? [];
  return (
    <section
      aria-label={several ? `Channel posts · ${account.userPrincipalName}` : 'Channel posts'}
      data-testid="channel-posts-settings"
      className="border-b border-line2 py-3 pr-6 pl-13"
    >
      <h3 className="m-0 font-mono text-label leading-none font-semibold uppercase tracking-caps text-muted">
        Channel posts{several && ` · ${account.userPrincipalName}`}
      </h3>
      {!access?.granted ? (
        <div className="mt-2 max-w-[640px]">
          <p className="m-0 text-note leading-[19px] text-ink">
            Off. Channel posts need the delegated permission{' '}
            <code className="font-mono">{CHANNEL_READ_PERMISSION}</code>, which an administrator approves for
            your organisation.
          </p>
          <Steps permissions={permissions} />
          <div className="mt-3">
            <Button disabled={busy} onClick={onRequest}>
              {busy ? 'Waiting for Microsoft…' : 'Request access'}
            </Button>
          </div>
          {problem && (
            <p role="alert" className="m-0 mt-3 text-note leading-[19px] text-ink">
              {problem.message}
            </p>
          )}
          {(problem?.adminConsent ??
            (access?.adminConsentUrl ? { permissions, url: access.adminConsentUrl } : null)) && (
            <AdminConsent
              needed={problem?.adminConsent ?? { permissions, url: access?.adminConsentUrl ?? '' }}
            />
          )}
        </div>
      ) : (
        <div className="mt-2">
          <div className="flex min-h-8 items-center gap-3">
            <Switch
              aria-label="Sync Channel posts"
              checked={access.enabled}
              disabled={busy}
              onCheckedChange={onEnabled}
            />
            <span className="text-note text-ink">Sync Channel posts</span>
            <span className="text-note text-muted">
              {access.enabled ? 'On · every channel unless excluded' : 'Off'}
            </span>
          </div>
          {problem && (
            <p role="alert" className="m-0 mt-2 text-note text-ink">
              {problem.message}
            </p>
          )}
          {access.enabled && <ChannelChoicesList choices={choices} onChange={onChange} />}
        </div>
      )}
    </section>
  );
}

export function ChannelPostsSettings({
  client,
  shown = true,
}: {
  client: ChannelPostsClient;
  shown?: boolean;
}) {
  const [accounts, setAccounts] = useState<TeamsAccountSummary[]>([]);
  const [choices, setChoices] = useState<ChannelChoices[]>([]);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reloadChoices = useCallback(() => {
    client.choices().then(setChoices, report);
  }, [client]);

  useEffect(() => {
    let live = true;
    client.accounts().then((found) => live && setAccounts(found), report);
    const stop = client.onAccounts((found) => {
      setAccounts(found);
      // A sync may have listed the teams just now.
      reloadChoices();
    });
    return () => {
      live = false;
      stop();
    };
  }, [client, reloadChoices]);

  useEffect(() => {
    if (shown) reloadChoices();
  }, [shown, reloadChoices]);

  const request = async (accountId: string) => {
    setBusy(accountId);
    setProblem(null);
    try {
      const response = await client.requestAccess(accountId);
      setAccounts(
        response.state.accounts.filter((each): each is TeamsAccountSummary => each.source === 'teams'),
      );
      if (!response.ok)
        setProblem({
          accountId,
          message: response.error,
          ...(response.adminConsent ? { adminConsent: response.adminConsent } : {}),
        });
      else toast('Commander can read Channel posts now. Switch on Sync Channel posts to bring them in.');
    } catch (error) {
      report(error);
    } finally {
      setBusy(null);
    }
  };

  const setEnabled = async (accountId: string, enabled: boolean) => {
    setBusy(accountId);
    setProblem(null);
    try {
      const response = await client.setEnabled(accountId, enabled);
      setAccounts(
        response.state.accounts.filter((each): each is TeamsAccountSummary => each.source === 'teams'),
      );
      if (!response.ok) setProblem({ accountId, message: response.error });
      else reloadChoices();
    } catch (error) {
      report(error);
    } finally {
      setBusy(null);
    }
  };

  const change = async (accountId: string, action: Omit<ChannelSettingAction, 'account'>) => {
    try {
      const next = await client.change({ ...action, account: accountId });
      setChoices((now) => [...now.filter((each) => each.account !== accountId), next]);
      // Included again: the next check brings its posts back.
      if (action.change === 'include') await client.syncNow(accountId);
    } catch (error) {
      report(error);
    }
  };

  if (!accounts.length) return null;
  return (
    <>
      {accounts.map((account) => (
        <AccountChannelPosts
          key={account.id}
          account={account}
          several={accounts.length > 1}
          choices={choices.find((each) => each.account === account.id) ?? null}
          problem={problem?.accountId === account.id ? problem : null}
          busy={busy === account.id}
          onRequest={() => void request(account.id)}
          onEnabled={(enabled) => void setEnabled(account.id, enabled)}
          onChange={(action) => void change(account.id, action)}
        />
      ))}
    </>
  );
}

function report(error: unknown) {
  toast(error instanceof Error ? error.message : String(error));
}
