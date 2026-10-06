import {
  type CloudMailAnswer,
  FILE_INTO_PROJECTS,
  LEARN_WRITING_STYLE,
  MODEL_COMPANIES,
  SORT_INTO_BUCKETS,
} from '@commander/domain';
import type { AccountsState } from '@commander/domain/ipc';
import { Button, ButtonGroup } from '@commander/ui';
import { useEffect, useState } from 'react';
import { SettingRow } from '../parts';

type GmailAccount = { id: string; email: string };

const gmailAccountsOf = (state: AccountsState): GmailAccount[] =>
  state.accounts.flatMap((account) =>
    account.source === 'google' && account.sources.some((each) => each.source === 'gmail' && each.enabled)
      ? [{ id: account.id, email: account.email }]
      : [],
  );

/**
 * Settings → Ares → Gmail and the cloud (#141): each Gmail Account's answer to "Let Ares read mail
 * from …?", changeable here. Allowed, Ares sorts and files its mail (sending it to the model's
 * company); not allowed (or not answered yet), he leaves it to the Rules and to the User.
 */
export function CloudMailRow() {
  const [accounts, setAccounts] = useState<GmailAccount[]>([]);
  const [answers, setAnswers] = useState<Record<string, CloudMailAnswer>>({});
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void window.commander.accounts({ op: 'list' }).then((response) => {
      if (live) setAccounts(gmailAccountsOf(response.state));
    });
    void window.commander.models({ op: 'settings' }).then((response) => {
      if (live && response.ok) setAnswers(response.result.cloudMail ?? {});
    });
    const stop = window.commander.onAccountsChanged((state) => setAccounts(gmailAccountsOf(state)));
    return () => {
      live = false;
      stop();
    };
  }, []);

  async function answer(account: string, choice: CloudMailAnswer) {
    const response = await window.commander.models({ op: 'set-cloud-mail', account, answer: choice });
    if (!response.ok) return setProblem(response.error);
    setProblem(null);
    setAnswers(response.result.cloudMail ?? {});
    if (choice === 'allowed') {
      for (const job of [SORT_INTO_BUCKETS, FILE_INTO_PROJECTS, LEARN_WRITING_STYLE])
        await window.commander.autonomy({ op: 'run-job', job }).catch(() => {});
    }
  }

  if (!accounts.length) return null;
  return (
    <SettingRow
      label="Gmail and the cloud"
      description={`To sort a Gmail Account’s mail into Buckets, file it into Projects and draft your replies, Ares sends each email’s sender, subject and text (never attachments) to ${MODEL_COMPANIES.zai}. Until you allow it for an Account, he leaves its mail to your Rules and to you.`}
    >
      <ul className="m-0 grid max-w-[560px] list-none gap-2 p-0" data-testid="cloud-mail-settings">
        {accounts.map((account) => {
          const now = answers[account.id];
          return (
            <li key={account.id} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-row text-ink">{account.email}</span>
              <ButtonGroup role="radiogroup" aria-label={`Ares reads mail from ${account.email}`}>
                {(['allowed', 'declined'] as const).map((choice) => (
                  <Button
                    key={choice}
                    role="radio"
                    aria-checked={now === choice}
                    variant={now === choice ? 'primary' : 'default'}
                    onClick={() => void answer(account.id, choice)}
                  >
                    {choice === 'allowed' ? 'Allowed' : 'Not allowed'}
                  </Button>
                ))}
              </ButtonGroup>
            </li>
          );
        })}
      </ul>
      {problem && <p className="m-0 mt-2 text-note font-semibold text-ink">{problem}</p>}
    </SettingRow>
  );
}
