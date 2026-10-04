import type { AccountSummary, AccountsRequest } from '@commander/domain/ipc';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@commander/ui';
import { useNow } from '../frame/use-now';
import { describeHourUse, describeSync } from './account-sync';

// One Account's sync in Settings → Accounts: last sync, how many Items, the next sync or why it's
// waiting, any problem in plain words, Sync now, and how often it syncs. A Source with a light sync
// (Teams) also has the switch for checking whenever another Source syncs, with Microsoft's caveat. A
// Source with hourly limits (GitHub) shows the last hour's use of them.

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
            {next}
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
      </div>
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
