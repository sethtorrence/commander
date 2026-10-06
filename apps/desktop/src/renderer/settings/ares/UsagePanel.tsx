import { jobDisplayName, type UsageSummary, type UsageTotals } from '@commander/domain';
import { Button, Led } from '@commander/ui';
import { useEffect, useState } from 'react';
import { Readout, ReadoutRow, SettingRow, SettingsGroup } from '../parts';
import { formatTokens, formatUsd } from './format';

// 'local': the embedding model search by meaning runs on this machine (#73), at no cost.
const PROVIDER_NAMES: Record<string, string> = { zai: 'Z.ai', local: 'This machine' };

const calls = (count: number) => `${count} ${count === 1 ? 'call' : 'calls'}`;

function TotalsRow({ label, totals, testId }: { label: string; totals: UsageTotals; testId: string }) {
  return (
    <ReadoutRow label={label}>
      <span data-testid={testId} className="tabular-nums">
        {formatUsd(totals.costUsd)} · {calls(totals.calls)}
        {totals.errors > 0 && ` · ${totals.errors} failed`}
      </span>
    </ReadoutRow>
  );
}

function Breakdown({
  title,
  rows,
  testId,
}: {
  title: string;
  rows: (UsageTotals & { name: string })[];
  testId: string;
}) {
  return (
    <table data-testid={testId} className="w-full max-w-[720px] border-collapse font-mono text-label-lg">
      <caption className="pb-1.5 text-left font-sans text-note font-semibold text-ink">{title}</caption>
      <thead>
        <tr className="border-y border-line text-muted uppercase tracking-tag">
          <th className="py-1.5 text-left font-semibold">{title.split(' ').at(-1)}</th>
          <th className="py-1.5 text-right font-semibold">Calls</th>
          <th className="py-1.5 text-right font-semibold">In</th>
          <th className="py-1.5 text-right font-semibold">Cached</th>
          <th className="py-1.5 text-right font-semibold">Out</th>
          <th className="py-1.5 text-right font-semibold">Cost</th>
        </tr>
      </thead>
      <tbody className="tabular-nums text-ink">
        {rows.map((row) => (
          <tr key={row.name} className="border-b border-line2">
            <td className="py-1.5">{row.name}</td>
            <td className="py-1.5 text-right">{row.calls}</td>
            <td className="py-1.5 text-right">{formatTokens(row.inputTokens)}</td>
            <td className="py-1.5 text-right">{formatTokens(row.cachedTokens)}</td>
            <td className="py-1.5 text-right">{formatTokens(row.outputTokens)}</td>
            <td className="py-1.5 text-right">{formatUsd(row.costUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CapRow({ usage }: { usage: UsageSummary }) {
  const cap = usage.monthlyCapUsd;
  if (cap === null) {
    return (
      <ReadoutRow label="Monthly cap">
        <span data-testid="usage-cap">None</span>
      </ReadoutRow>
    );
  }
  const share = Math.round((usage.thisMonth.costUsd / cap) * 100);
  return (
    <ReadoutRow label="Monthly cap" live={usage.capWarning !== null}>
      {usage.capWarning && <Led size="sm" />}
      <span data-testid="usage-cap" className="tabular-nums">
        {formatUsd(usage.thisMonth.costUsd)} of {formatUsd(cap)} ({share}%)
      </span>
    </ReadoutRow>
  );
}

/** Settings → Ares → Usage: what model calls cost today and this month. */
export function UsagePanel({ no, version }: { no: string; version: number }) {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [refreshes, setRefreshes] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version and refreshes ask for a fresh read
  useEffect(() => {
    window.commander.models({ op: 'usage' }).then((response) => {
      if (response.ok) setUsage(response.result);
    });
  }, [version, refreshes]);

  return (
    <SettingsGroup
      no={no}
      title="Usage"
      note={usage ? `Model calls · ${usage.month}` : 'Model calls'}
      data-testid="usage-panel"
    >
      <SettingRow
        label="Totals"
        description="Every model call is counted and costed, cap or no cap. Prompts and replies are never kept."
      >
        {usage && (
          <Readout>
            <TotalsRow label="Today" totals={usage.today} testId="usage-today" />
            <TotalsRow label="This month" totals={usage.thisMonth} testId="usage-month" />
            <CapRow usage={usage} />
            {usage.thisMonth.unpricedCalls > 0 && (
              <ReadoutRow label="Unpriced">
                <span>{calls(usage.thisMonth.unpricedCalls)} to models with no known price</span>
              </ReadoutRow>
            )}
          </Readout>
        )}
        {usage?.capWarning && (
          <p data-testid="usage-cap-warning" className="m-0 mt-2 text-note leading-[19px] text-signal-ink">
            This month’s spend passed 80% of the cap on {new Date(usage.capWarning.at).toLocaleDateString()}.
          </p>
        )}
        <Button className="mt-3" size="sm" onClick={() => setRefreshes((count) => count + 1)}>
          Refresh
        </Button>
      </SettingRow>
      {usage && usage.thisMonth.calls > 0 && (
        <SettingRow label="This month" description="By day, by job and by provider.">
          <div className="grid gap-5">
            <Breakdown
              title="By day"
              testId="usage-by-day"
              rows={usage.byDay.map((row) => ({ ...row, name: row.day }))}
            />
            <Breakdown
              title="By job"
              testId="usage-by-job"
              rows={usage.byJob.map((row) => ({ ...row, name: jobDisplayName(row.job) }))}
            />
            <Breakdown
              title="By provider"
              testId="usage-by-provider"
              rows={usage.byProvider.map((row) => ({
                ...row,
                name: PROVIDER_NAMES[row.provider] ?? row.provider,
              }))}
            />
          </div>
        </SettingRow>
      )}
    </SettingsGroup>
  );
}
