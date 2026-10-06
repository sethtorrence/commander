import type { BucketMirroring, MirrorSource } from '@commander/domain';
import type { GoogleAccountSummary, OutlookAccountSummary } from '@commander/domain/ipc';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  Switch,
  toast,
} from '@commander/ui';
import { useCallback, useEffect, useState } from 'react';
import { errorText } from '../projects/change-with-undo';
import { SettingsLink } from '../settings/SettingsLink';
import type { MirroringClient } from './mirroring';

/**
 * Mirror Buckets for one Google or Outlook Account (#142), in Settings → Accounts: off by default, with
 * a line saying Commander's Buckets may differ from how the User organises mail there. Switching it on
 * first says what will happen (and, for Outlook, asks Microsoft for MailboxSettings.ReadWrite through
 * Grant access); switching it off offers to remove Commander's labels or categories, or keep them.
 */
export function BucketMirroringSetting({
  account,
  client,
}: {
  account: GoogleAccountSummary | OutlookAccountSummary;
  client: MirroringClient;
}) {
  const source: MirrorSource = account.source === 'google' ? 'gmail' : 'outlook';
  const where = source === 'gmail' ? 'Gmail' : 'Outlook';
  const labels = source === 'gmail' ? 'labels' : 'categories';
  const [state, setState] = useState<BucketMirroring | null>(null);
  const [asking, setAsking] = useState<'on' | 'off' | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const mail = account.sources.find((each) => each.source === source);
  const granted = source === 'gmail' || !!(account as OutlookAccountSummary).mailboxSettings?.granted;

  const reload = useCallback(
    () =>
      Promise.resolve()
        .then(() => client.list())
        .then(
          (all) => setState(all.find((each) => each.account === account.id) ?? null),
          () => {},
        ),
    [client, account.id],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  const set = async (enabled: boolean, removeLabels = false) => {
    setBusy(true);
    setProblem(null);
    try {
      if (enabled && !granted) {
        const answer = await client.grant(account.id);
        if (!answer.ok) {
          setProblem(answer.error);
          return;
        }
      }
      setState(await client.set({ account: account.id, source, enabled, removeLabels }));
      if (removeLabels) toast(`Removing Commander’s ${labels} from ${where}`);
    } catch (reason) {
      setProblem(errorText(reason));
      await reload();
    } finally {
      setBusy(false);
      setAsking(null);
    }
  };

  const on = !!state?.enabled;
  return (
    <div data-testid="bucket-mirroring" className="mt-3 max-w-[560px]">
      <div className="flex min-h-8 flex-wrap items-center gap-3">
        <Switch
          aria-label={`Mirror Buckets to ${where}`}
          checked={on}
          disabled={busy || !mail?.enabled}
          onCheckedChange={(next) => setAsking(next ? 'on' : 'off')}
        />
        <span className="text-note text-ink">Mirror Buckets to {where}</span>
        <span className="text-note text-muted">
          {state?.removing ? `Removing Commander’s ${labels}…` : on ? 'On' : 'Off'}
        </span>
      </div>
      <p className="m-0 mt-1 text-note leading-[19px] text-muted">
        Shows each email’s Bucket in {where} as{' '}
        {source === 'gmail' ? 'a Commander/<Bucket> label' : 'a “Commander: <Bucket>” category'}, and moves an
        email in Commander when you change it there. Commander’s Buckets may differ from how you organise mail
        in {where}.
      </p>
      {state?.paused && (
        <p className="m-0 mt-1 text-note leading-[19px] text-ink">
          Paused: Mirror Buckets is below Auto in{' '}
          <SettingsLink to={{ group: 'autonomy' }}>Settings → Autonomy</SettingsLink>, so nothing is written
          to {where}.
        </p>
      )}
      {problem && (
        <p
          role="alert"
          className="m-0 mt-2 border-l-2 border-signal py-0.5 pl-3.5 text-note leading-[19px] text-ink"
        >
          {problem}
        </p>
      )}
      <Dialog open={asking === 'on'} onOpenChange={(open) => !open && setAsking(null)}>
        <DialogContent aria-describedby={undefined} className="w-[min(560px,calc(100vw-48px))]">
          <DialogHeader partNumber="MIR">
            <DialogTitle>Mirror Buckets to {where}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogHeading>Show your Buckets in {account.name.replace(/^\w+ · /, '')}?</DialogHeading>
            <DialogDescription>
              {source === 'gmail'
                ? 'Commander puts a Commander/<Bucket> label on every email it holds that is in a Bucket (and on new mail as it is sorted), keeps exactly one on each, and makes, renames and deletes those labels with your Buckets.'
                : 'Commander puts a “Commander: <Bucket>” category on every email it holds that is in a Bucket (and on new mail as it is sorted), keeps exactly one on each beside your own categories, and makes and deletes those categories with your Buckets, in Outlook’s colours.'}{' '}
              Change one in {where} and the email moves to that Bucket in Commander. Commander never changes
              your own {labels}. Switch it off at any time, keeping or removing Commander’s {labels}.
            </DialogDescription>
            {!granted && (
              <p className="m-0 mt-3 text-note leading-[19px] text-ink">
                First, Microsoft asks you to let Commander manage your mailbox settings
                (MailboxSettings.ReadWrite), which making categories needs. Approve it in your browser, then
                come back here.
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setAsking(null)}>Cancel</Button>
            <Button variant="primary" disabled={busy} onClick={() => void set(true)}>
              {granted ? 'Mirror Buckets' : 'Grant access and mirror'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={asking === 'off'} onOpenChange={(open) => !open && setAsking(null)}>
        <DialogContent aria-describedby={undefined} className="w-[min(560px,calc(100vw-48px))]">
          <DialogHeader partNumber="MIR">
            <DialogTitle>Stop mirroring Buckets</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogHeading>
              Remove Commander’s {labels} from {where} too?
            </DialogHeading>
            <DialogDescription>
              Commander stops writing Buckets to {where} either way, and your Buckets in Commander stay as
              they are. Removing takes every Commander {source === 'gmail' ? 'label' : 'category'} off your
              mail
              {source === 'gmail' ? ' and deletes the labels' : ' and deletes the categories'}; your own{' '}
              {labels} are never touched.
            </DialogDescription>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setAsking(null)}>Cancel</Button>
            <Button disabled={busy} onClick={() => void set(false)}>
              Keep them
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void set(false, true)}>
              Remove Commander {labels}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
