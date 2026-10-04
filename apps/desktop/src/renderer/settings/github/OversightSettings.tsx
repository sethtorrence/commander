import type { OversightSettings as Settings } from '@commander/domain';
import { Input, toast } from '@commander/ui';
import { useEffect, useRef, useState } from 'react';
import type { ItemStoreClient } from '../../item-store/client';
import { SettingRow } from '../parts';

// "dependabot, renovate" ↔ ['dependabot', 'renovate'].
const listOf = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((each) => each.trim())
    .filter(Boolean);
// Labels may hold spaces ("good first issue"): only commas part them.
const labelsOf = (text: string) =>
  text
    .split(',')
    .map((each) => each.trim())
    .filter(Boolean);

/**
 * Settings → GitHub → Oversight summary (#119): when an open pull request counts as Stuck for being
 * old and quiet (both in days), which authors are bots, left out of Started besides every `[bot]`
 * login, and the skill-managed labels (#120). Each saves when its field is left (or on Enter).
 */
export function OversightSettings({
  itemStore = window.commander.itemStore,
}: {
  itemStore?: ItemStoreClient;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [old, setOld] = useState('');
  const [idle, setIdle] = useState('');
  const [bots, setBots] = useState('');
  const [skillLabels, setSkillLabels] = useState('');

  // What is saved, or being saved: each field's change builds on the last, answered or not.
  const latest = useRef<Settings | null>(null);
  const show = (next: Settings) => {
    latest.current = next;
    setSettings(next);
    setOld(String(next.longRunningDays));
    setIdle(String(next.idleDays));
    setBots(next.bots.join(', '));
    setSkillLabels(next.skillLabels.join(', '));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: `show` only sets state
  useEffect(() => {
    itemStore({ op: 'github-oversight-settings' }).then(show, () => {});
  }, [itemStore]);

  const save = (changes: Partial<Settings>) => {
    const before = latest.current;
    if (!before) return;
    const next = { ...before, ...changes };
    if (JSON.stringify(next) === JSON.stringify(before)) return;
    latest.current = next;
    itemStore({ op: 'save-github-oversight-settings', settings: next }).then(show, (error) => {
      toast(error instanceof Error ? error.message : String(error));
      show(before);
    });
  };
  const days = (text: string, key: 'longRunningDays' | 'idleDays') => {
    const n = Number(text);
    if (Number.isInteger(n) && n >= 1 && n <= 365) save({ [key]: n });
    else if (latest.current) show(latest.current);
  };
  const onEnter = (key: { key: string; currentTarget: HTMLInputElement }) => {
    if (key.key === 'Enter') key.currentTarget.blur();
  };

  return (
    <>
      <SettingRow
        label="Stuck pull requests"
        description="The oversight summary counts an open pull request as Stuck when it is older than this and has had no activity for that long. A review waiting more than 2 days, and failing checks, count too."
      >
        <div className="flex items-center gap-2 text-note text-text">
          Older than
          <Input
            aria-label="Stuck after days open"
            data-testid="oversight-long-running"
            inputMode="numeric"
            className="w-16"
            value={old}
            disabled={!settings}
            onChange={(change) => setOld(change.target.value)}
            onBlur={() => days(old, 'longRunningDays')}
            onKeyDown={onEnter}
          />
          days, with no activity for
          <Input
            aria-label="Stuck after days without activity"
            data-testid="oversight-idle"
            inputMode="numeric"
            className="w-16"
            value={idle}
            disabled={!settings}
            onChange={(change) => setIdle(change.target.value)}
            onBlur={() => days(idle, 'idleDays')}
            onKeyDown={onEnter}
          />
          days
        </div>
      </SettingRow>
      <SettingRow
        label="Bots"
        description="GitHub logins whose pull requests and issues never count as Started in the oversight summary. Every [bot] login is left out anyway."
      >
        <Input
          aria-label="Bots"
          data-testid="oversight-bots"
          className="max-w-[460px]"
          placeholder="dependabot, renovate"
          value={bots}
          disabled={!settings}
          onChange={(change) => setBots(change.target.value)}
          onBlur={() => save({ bots: listOf(bots) })}
          onKeyDown={onEnter}
        />
      </SettingRow>
      <SettingRow
        label="Skill-managed labels"
        description="Issues with any of these labels are wayfinder maps and build tickets your skills keep open on purpose: they show as progress, count as work once claimed or closed, and never as Stuck. A trailing * matches any suffix; an issue labelled wayfinder:map is always a map."
      >
        <Input
          aria-label="Skill-managed labels"
          data-testid="oversight-skill-labels"
          className="max-w-[460px]"
          placeholder="wayfinder:*, ready-for-agent"
          value={skillLabels}
          disabled={!settings}
          onChange={(change) => setSkillLabels(change.target.value)}
          onBlur={() => save({ skillLabels: labelsOf(skillLabels) })}
          onKeyDown={onEnter}
        />
      </SettingRow>
    </>
  );
}
