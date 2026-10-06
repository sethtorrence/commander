import { type CloudMailAnswer, cloudMailQuestion } from '@commander/domain';
import { Button } from '@commander/ui';
import { type EmailAccountSummary, emailAddressOf } from './email';

/*
  Gmail and the cloud (#141, decision #19): before any of a Gmail Account's mail goes to a cloud model,
  Commander asks once, for that Account, in plain words naming the model's company. Until the User
  answers (and after Don't allow), Ares leaves the Account's mail to the Rules and to the User. The
  answer can be changed in Settings → Ares. Shown at the top of the Email Section, never as a pop-up.
*/

export function CloudMailQuestions({
  accounts,
  onAnswer,
}: {
  accounts: readonly EmailAccountSummary[];
  onAnswer: (account: string, answer: CloudMailAnswer) => void;
}) {
  if (!accounts.length) return null;
  return (
    <div className="flex flex-none flex-col">
      {accounts.map((account) => {
        const address = emailAddressOf(account);
        return (
          <section
            key={account.id}
            aria-label={`Ares and ${address}`}
            data-testid="cloud-mail-question"
            className="flex items-center gap-4 border-b border-line bg-raise py-2.5 pr-4 pl-13"
          >
            <p className="m-0 min-w-0 flex-1 text-note leading-snug text-text">
              {cloudMailQuestion(address)}
            </p>
            <Button size="sm" variant="signal" onClick={() => onAnswer(account.id, 'allowed')}>
              Allow
            </Button>
            <Button size="sm" onClick={() => onAnswer(account.id, 'declined')}>
              Don’t allow
            </Button>
          </section>
        );
      })}
    </div>
  );
}
