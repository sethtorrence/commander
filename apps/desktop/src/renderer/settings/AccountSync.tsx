import type { AccountSummary, AccountsRequest } from '@commander/domain/ipc';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@commander/ui';
import { useNow } from '../frame/use-now';
import { describeSync } from './account-sync';

// One Account's sync in Settings → Accounts: last sync, how many Items, the next sync or why it's
// waiting, any problem in plain words, Sync now, and how often it syncs.
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
        <Button disabled={!canSync} onClick={() => request({ op: 'sync-now', accountId: account.id })}>
          Sync now
        </Button>
      </div>
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
