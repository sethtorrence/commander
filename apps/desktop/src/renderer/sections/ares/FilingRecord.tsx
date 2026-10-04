import { type FilingCounts, filingAccuracy, type FilingRecord as Record } from '@commander/domain';
import { toast } from '@commander/ui';
import { useEffect, useState } from 'react';
import { SettingsGroup } from '../../settings/parts';
import { SOURCE_NAMES } from '../todos/todos';
import type { AutonomyClient } from './activity';

const STATS: [keyof FilingCounts, string, string][] = [
  ['filed', 'Filed', 'Items he filed into a Project on his own'],
  ['suggested', 'Suggested', 'Items he wasn’t sure about: the dashed Badge'],
  ['confirmed', 'Confirmed', 'Filings you kept: Confirm, or the same Project with B'],
  ['corrected', 'Corrected', 'Filings you changed: Change, or another Project with B'],
];

const kept = (counts: FilingCounts) => {
  const share = filingAccuracy(counts);
  return share === null ? '–' : `${Math.round(share * 100)}%`;
};

/** The same counts for each Source, so his filing on Teams (or Linear) can be read on its own. */
function BySource({ rows }: { rows: Record['bySource'] }) {
  const cell = 'py-1.5 text-right';
  return (
    <div className="border-b border-line2 pt-2 pr-5 pb-3 pl-13">
      <table
        aria-label="Filing by Source"
        className="w-full max-w-[720px] border-collapse font-mono text-label-lg"
      >
        <thead>
          <tr className="border-y border-line text-muted uppercase tracking-tag">
            <th className="py-1.5 text-left font-semibold">Source</th>
            {STATS.map(([key, label]) => (
              <th key={key} className={`${cell} font-semibold`}>
                {label}
              </th>
            ))}
            <th className={`${cell} font-semibold`}>Kept</th>
          </tr>
        </thead>
        <tbody className="tabular-nums text-ink">
          {rows.map((row) => (
            <tr key={row.source ?? 'commander'} className="border-b border-line2">
              <th scope="row" className="py-1.5 text-left font-medium">
                {row.source ? SOURCE_NAMES[row.source] : 'Commander'}
              </th>
              {STATS.map(([key]) => (
                <td key={key} className={cell}>
                  {row[key]}
                </td>
              ))}
              <td className={cell}>{kept(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Ares's filing record on his activity page (#71, #108): how many Items he filed, how many he
 * suggested, and how many of those you confirmed or corrected, in all and for each Source, so his
 * accuracy on your real Linear and Teams data can be read off directly. Read again whenever he does
 * something, and when the page is shown.
 */
export function FilingRecord({
  client,
  shown,
  onAresActivity,
}: {
  client: AutonomyClient;
  shown: boolean;
  onAresActivity?: (listener: () => void) => () => void;
}) {
  const [record, setRecord] = useState<Record | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => onAresActivity?.(() => setVersion((v) => v + 1)), [onAresActivity]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload
  useEffect(() => {
    if (!shown) return;
    let current = true;
    client({ op: 'filing-record' }).then(
      (next) => current && setRecord(next),
      (error: unknown) => toast(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      current = false;
    };
  }, [client, shown, version]);

  const accuracy = record && filingAccuracy(record);
  return (
    <SettingsGroup
      no="A2"
      title="Filing into Projects"
      note={accuracy === null || accuracy === undefined ? undefined : `${Math.round(accuracy * 100)}% kept`}
    >
      <dl data-testid="filing-record" className="m-0 grid grid-cols-4 border-b border-line2 pr-5 pl-13">
        {STATS.map(([key, label, description]) => (
          <div
            key={key}
            className="border-l border-line2 py-2.5 pl-3 first:border-l-0 first:pl-0"
            title={description}
          >
            <dt className="font-mono text-label leading-none font-semibold uppercase tracking-label text-muted">
              {label}
            </dt>
            <dd
              data-testid={`filing-record-${key}`}
              className="m-0 mt-1.5 font-mono text-[20px] leading-none font-semibold text-ink tabular-nums"
            >
              {record ? record[key] : '–'}
            </dd>
          </div>
        ))}
      </dl>
      {record && record.bySource.length > 0 && <BySource rows={record.bySource} />}
    </SettingsGroup>
  );
}
