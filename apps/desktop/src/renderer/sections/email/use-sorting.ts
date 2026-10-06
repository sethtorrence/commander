import { type CloudMailAnswer, type SortingProgress, sortingLine } from '@commander/domain';
import { useCallback, useEffect, useState } from 'react';
import type { ItemChanges } from '../../item-store/changes';
import type { EmailAccountSummary, EmailClient } from './email';

/*
  Ares's sorting in the Email Section (#141): how far he has got with the mail in scope ("Ares is
  sorting: 400 of 3,000", beside the sync status), read again as Items change and every little while
  as long as he has more to do; and Gmail and the cloud: the Gmail Accounts whose mail he may not read
  yet because the User hasn't answered "Let Ares read mail from …?", and answering it.
*/

// How often the progress is read again while Ares is sorting.
const PROGRESS_EVERY_MS = 10_000;

export type AresSorting = {
  /** "Ares is sorting: 400 of 3,000", or null when there is nothing left to sort. */
  line: string | null;
  /** The Gmail Accounts still waiting for the User's answer about the cloud. */
  unanswered: EmailAccountSummary[];
  answer(account: string, answer: CloudMailAnswer): Promise<void>;
};

export function useAresSorting({
  client,
  accounts,
  changes,
}: {
  client: EmailClient;
  accounts: readonly EmailAccountSummary[];
  changes: ItemChanges;
}): AresSorting {
  const [progress, setProgress] = useState<SortingProgress | null>(null);
  const [answers, setAnswers] = useState<Record<string, CloudMailAnswer> | null>(null);
  const [version, setVersion] = useState(0);
  const again = useCallback(() => setVersion((n) => n + 1), []);

  useEffect(() => changes(again), [changes, again]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` and the Accounts say when to read again
  useEffect(() => {
    let live = true;
    client.sorting().then(
      (found) => live && setProgress(found),
      () => {},
    );
    client.cloudMail().then(
      (found) => live && setAnswers(found),
      () => live && setAnswers({}),
    );
    return () => {
      live = false;
    };
  }, [client, version, accounts]);

  const line = progress ? sortingLine(progress) : null;
  useEffect(() => {
    if (!line) return;
    const timer = setInterval(again, PROGRESS_EVERY_MS);
    return () => clearInterval(timer);
  }, [line, again]);

  const unanswered = answers
    ? accounts.filter(
        (account) =>
          account.source === 'google' &&
          account.sources.some((each) => each.source === 'gmail' && each.enabled) &&
          !answers[account.id],
      )
    : [];

  const answer = useCallback(
    async (account: string, choice: CloudMailAnswer) => {
      setAnswers((now) => ({ ...now, [account]: choice }));
      await client.answerCloudMail(account, choice);
      again();
    },
    [client, again],
  );

  return { line, unanswered, answer };
}
