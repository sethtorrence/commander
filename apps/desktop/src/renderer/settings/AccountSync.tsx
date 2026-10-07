import type { AccountSummary, AccountSyncStatus, AccountsRequest } from '@commander/domain/ipc';
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@commander/ui';
import { useState } from 'react';
import { useNow } from '../frame/use-now';
import { describeHourUse, describeResync, describeSync } from './account-sync';
import { OutgoingChanges } from './OutgoingChanges';

// One Account's sync in Settings → Accounts: last sync, how many Items, the next sync or why it's
// waiting, any problem in plain words, Sync now, Re-sync (#205, after a short confirmation, with its
// progress in place of the next sync), how often it syncs, and its changes waiting to reach the
// Source or that couldn't sync (#206, OutgoingChanges.tsx). A Source with a light sync (Teams)
// also has the switch for checking whenever another Source syncs, with Microsoft's caveat. A Source
// with hourly limits (GitHub) shows the last hour's use of them.

// The Sources an Account carrying several syncs, as the User knows them.
const SOURCE_NAMES: Partial<Record<AccountSyncStatus['source'], string>> = {
  gmail: 'Gmail',
  'google-calendar': 'Google Calendar',
  outlook: 'Outlook',
  'outlook-calendar': 'Outlook Calendar',
};

// The Account's re-sync line, from whichever of its Sources is re-syncing (the running one first);
// null when none is. An Account carrying several Sources names the one.
function resyncLine(account: AccountSummary): string | null {
  const carried = 'sources' in account ? account.sources.map((each) => each.sync ?? null) : [];
  const statuses = [account.sync ?? null, ...carried].filter((each) => each?.resync) as AccountSyncStatus[];
  const shown = statuses.find((each) => each.activity === 'syncing') ?? statuses[0];
  if (!shown) return null;
  return describeResync(shown, 'sources' in account ? SOURCE_NAMES[shown.source] : undefined);
}

// Re-sync, after saying what it does and that nothing of the User's is lost.
function ResyncAccount({
  account,
  disabled,
  onResync,
}: {
  account: AccountSummary;
  disabled: boolean;
  onResync: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button disabled={disabled} onClick={() => setOpen(true)}>
        Re-sync
      </Button>
      <DialogContent aria-describedby={undefined} data-testid="resync-account-dialog">
        <DialogHeader>
          <DialogTitle>Re-sync Account</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogHeading>Re-sync {account.name}?</DialogHeading>
          <DialogDescription>
            Commander forgets where it got to with this Account and reads everything in it again, at the
            Source’s usual pace. Nothing of yours is lost: your notes, Todos, Links, Projects, Buckets and
            snoozes stay on the same Items, and none appears twice.
          </DialogDescription>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button
            variant="primary"
            onClick={() => {
              onResync();
              setOpen(false);
            }}
          >
            Re-sync {account.name}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// "Every 15 min", or for a Source with one choice, a plain line ("Full sync once a day").
const every = (minutes: number) => (minutes === 1440 ? 'once a day' : `every ${minutes} min`);
export function AccountSync({
  account,
  request,
}: {
  account: AccountSummary;
  request: (request: AccountsRequest) => void;
}) {
  const now = useNow(30_000);
  const { sync } = account;
  if (!sync) return null;
  const { synced, next, problem } = describeSync(sync, now);
  const resync = resyncLine(account);
  const canSync = sync.activity === 'idle' || sync.activity === 'backing-off';
  const light = sync.alsoAfterOtherSources !== undefined;
  const hourUse = describeHourUse(sync);
  return (
    <div data-testid="account-sync" className="mt-3 max-w-[560px]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-[220px] flex-1 font-mono text-label-lg leading-[1.4] uppercase tracking-tag">
          <div data-testid="account-synced" className="font-semibold text-ink">
            {synced}
          </div>
          <div data-testid="account-next-sync" className="text-muted">
            {resync ?? next}
          </div>
        </div>
        {sync.cadenceChoices.length > 1 ? (
          <Select
            value={String(sync.cadenceMinutes)}
            onValueChange={(minutes) =>
              request({ op: 'set-sync-cadence', accountId: account.id, minutes: Number(minutes) })
            }
          >
            <SelectTrigger aria-label={`How often to sync ${account.name}`} className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sync.cadenceChoices.map((minutes) => (
                <SelectItem key={minutes} value={String(minutes)}>
                  Every {minutes} min
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span data-testid="account-cadence" className="text-note text-muted">
            {light ? 'Full sync' : 'Syncs'} {every(sync.cadenceMinutes)}
          </span>
        )}
        <Button disabled={!canSync} onClick={() => request({ op: 'sync-now', accountId: account.id })}>
          Sync now
        </Button>
        <ResyncAccount
          account={account}
          disabled={resync !== null || sync.activity === 'needs-reconnect'}
          onResync={() => request({ op: 'resync', accountId: account.id })}
        />
      </div>
      <OutgoingChanges account={account} />
      {hourUse && (
        <p data-testid="account-hour-use" className="m-0 mt-2 text-note leading-[19px] text-muted">
          {hourUse}
        </p>
      )}
      {light && (
        <div className="mt-3">
          <div className="flex items-center gap-3 text-note text-ink">
            <Switch
              data-testid="account-check-alongside"
              aria-label="Also check whenever another Source syncs"
              checked={sync.alsoAfterOtherSources ?? true}
              onCheckedChange={(enabled) =>
                request({ op: 'set-sync-also-after-other-sources', accountId: account.id, enabled })
              }
            />
            <span aria-hidden="true">Also check whenever another Source syncs</span>
          </div>
          <p className="m-0 mt-2 text-note leading-[19px] text-muted">
            Microsoft asks apps to check Teams about once a day. Checking more often risks slower or paused
            Teams access for Commander.
          </p>
        </div>
      )}
      {problem && (
        <p
          data-testid="account-sync-problem"
          role="status"
          className="m-0 mt-2 border-l-2 border-signal py-0.5 pl-3.5 text-note leading-[19px] text-ink"
        >
          {problem}
        </p>
      )}
    </div>
  );
}
