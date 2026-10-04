import { filingAccuracy, type FilingRecord as Record } from '@commander/domain';
import { toast } from '@commander/ui';
import { useEffect, useState } from 'react';
import { SettingsGroup } from '../../settings/parts';
import type { AutonomyClient } from './activity';

const STATS: [keyof Record, string, string][] = [
  ['filed', 'Filed', 'Items he filed into a Project on his own'],
  ['suggested', 'Suggested', 'Items he wasn’t sure about: the dashed Badge'],
  ['confirmed', 'Confirmed', 'Filings you kept: Confirm, or the same Project with B'],
  ['corrected', 'Corrected', 'Filings you changed: Change, or another Project with B'],
];

/**
 * Ares's filing record on his activity page (#71): how many Items he filed, how many he suggested,
 * and how many of those you confirmed or corrected, so his accuracy on your real Linear data can be
 * read off directly. Read again whenever he does something, and when the page is shown.
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
    </SettingsGroup>
  );
}
