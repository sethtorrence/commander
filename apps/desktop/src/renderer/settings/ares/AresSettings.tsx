import {
  jobName,
  type ModelSettings,
  type ModelTestResult,
  type ModelTier,
  modelSettings,
  type ReasoningEffort,
  reasoningEfforts,
  type TierSetting,
} from '@commander/domain';
import {
  Button,
  ButtonGroup,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@commander/ui';
import { type FormEvent, type ReactNode, useEffect, useReducer, useState } from 'react';
import { Readout, ReadoutRow, SettingRow, SettingsGroup } from '../parts';
import { formatLatency, formatUsd } from './format';
import { UsagePanel } from './UsagePanel';

const EFFORT_NAMES: Record<ReasoningEffort, string> = { low: 'Low', high: 'High', max: 'Max' };
const TIER_NAMES: Record<ModelTier, string> = { quick: 'Quick', deep: 'Deep' };

function Problem({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <p
      data-testid={testId}
      role="alert"
      className="m-0 mt-3 max-w-[560px] border-l-2 border-signal py-0.5 pl-3.5 text-note leading-[19px] text-ink"
    >
      {children}
    </p>
  );
}

function Note({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p data-testid={testId} className="m-0 mt-2 text-note leading-[19px] text-muted">
      {children}
    </p>
  );
}

function ThinkingChoice({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ReasoningEffort;
  onChange: (effort: ReasoningEffort) => void;
}) {
  return (
    <ButtonGroup role="radiogroup" aria-label={label}>
      {reasoningEfforts.map((effort) => (
        <Button
          key={effort}
          role="radio"
          aria-checked={value === effort}
          variant={value === effort ? 'primary' : 'default'}
          onClick={() => onChange(effort)}
        >
          {EFFORT_NAMES[effort]}
        </Button>
      ))}
    </ButtonGroup>
  );
}

// The Z.ai API key: saved through the main process into the keyring, and never shown again.
function ApiKeyRow({ onChange }: { onChange: () => void }) {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    window.commander.modelKeyStatus('zai').then((status) => setSaved(status.saved));
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    const result = await window.commander.saveModelKey('zai', draft);
    if (!result.ok) {
      setProblem(result.error);
      return;
    }
    setDraft('');
    setProblem(null);
    setSaved(true);
    onChange();
  }

  async function remove() {
    await window.commander.clearModelKey('zai');
    setSaved(false);
    onChange();
  }

  return (
    <SettingRow
      label="Z.ai API key"
      description="A pay-as-you-go key from z.ai. Kept in the system keyring; Commander never shows it again."
    >
      <form className="flex max-w-[560px] gap-2" onSubmit={save}>
        <Input
          data-testid="model-key-input"
          type="password"
          aria-label="Z.ai API key"
          autoComplete="off"
          spellCheck={false}
          placeholder={saved ? 'Paste a new key to replace the saved one' : 'Paste your Z.ai API key'}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" variant="primary" disabled={!draft.trim()} data-testid="model-key-save">
          Save key
        </Button>
        {saved && (
          <Button onClick={remove} data-testid="model-key-remove">
            Remove
          </Button>
        )}
      </form>
      <Note testId="model-key-status">
        {saved === null ? '…' : saved ? 'A key is saved in the keyring.' : 'No key saved yet.'}
      </Note>
      {problem && <Problem testId="model-key-problem">{problem}</Problem>}
    </SettingRow>
  );
}

// Test: a one-line Quick call, showing the reply, how long it took and what it cost.
function TestRow({ onCall }: { onCall: () => void }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ModelTestResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function test() {
    setRunning(true);
    setProblem(null);
    setResult(null);
    const response = await window.commander.models({ op: 'test' });
    setRunning(false);
    if (response.ok) setResult(response.result);
    else setProblem(response.error);
    onCall();
  }

  return (
    <SettingRow label="Test" description="Sends Ares one short Quick-tier message and shows his reply.">
      <Button onClick={test} disabled={running} data-testid="model-test">
        {running ? 'Testing…' : 'Test'}
      </Button>
      {result && (
        <Readout className="mt-3">
          <ReadoutRow label="Reply">
            <span data-testid="model-test-reply" className="normal-case tracking-normal">
              {result.reply}
            </span>
          </ReadoutRow>
          <ReadoutRow label="Model">
            <span className="normal-case">{result.model}</span>
          </ReadoutRow>
          <ReadoutRow label="Latency">
            <span data-testid="model-test-latency">{formatLatency(result.latencyMs)}</span>
          </ReadoutRow>
          <ReadoutRow label="Cost">
            <span data-testid="model-test-cost">{formatUsd(result.costUsd)}</span>
          </ReadoutRow>
        </Readout>
      )}
      {problem && <Problem testId="model-test-problem">{problem}</Problem>}
    </SettingRow>
  );
}

function TierFields({
  tier,
  setting,
  onChange,
}: {
  tier: string;
  setting: TierSetting;
  onChange: (setting: TierSetting) => void;
}) {
  return (
    <div className="grid max-w-[560px] gap-2" data-testid={`tier-${tier.toLowerCase()}`}>
      <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2">
        <Select value={setting.provider} onValueChange={() => onChange(setting)}>
          <SelectTrigger aria-label={`${tier} provider`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zai">Z.ai</SelectItem>
          </SelectContent>
        </Select>
        <Input
          aria-label={`${tier} model`}
          font="mono"
          className="normal-case"
          value={setting.model}
          onChange={(event) => onChange({ ...setting, model: event.target.value })}
        />
      </div>
      <Input
        aria-label={`${tier} base URL`}
        font="mono"
        className="normal-case"
        value={setting.baseUrl}
        onChange={(event) => onChange({ ...setting, baseUrl: event.target.value })}
      />
      <ThinkingChoice
        label={`${tier} thinking`}
        value={setting.reasoningEffort}
        onChange={(reasoningEffort) => onChange({ ...setting, reasoningEffort })}
      />
    </div>
  );
}

function JobOverrides({
  overrides,
  onChange,
}: {
  overrides: ModelSettings['jobOverrides'];
  onChange: (overrides: ModelSettings['jobOverrides']) => void;
}) {
  const [job, setJob] = useState('');
  const [effort, setEffort] = useState<ReasoningEffort>('high');
  const valid = jobName.safeParse(job).success;

  function add(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    onChange({ ...overrides, [job.trim()]: { reasoningEffort: effort } });
    setJob('');
  }

  function remove(name: string) {
    const { [name]: _removed, ...rest } = overrides;
    onChange(rest);
  }

  const entries = Object.entries(overrides);
  return (
    <div className="max-w-[560px]">
      {entries.length > 0 && (
        <div data-testid="job-overrides">
          <Readout className="mb-3">
            {entries.map(([name, override]) => (
              <ReadoutRow key={name} label={name}>
                {EFFORT_NAMES[override.reasoningEffort]}
                <Button size="sm" variant="ghost" onClick={() => remove(name)} aria-label={`Remove ${name}`}>
                  Remove
                </Button>
              </ReadoutRow>
            ))}
          </Readout>
        </div>
      )}
      <form className="flex flex-wrap gap-2" onSubmit={add}>
        <Input
          aria-label="Job"
          font="mono"
          className="max-w-56 normal-case"
          placeholder="e.g. draft-reply"
          value={job}
          onChange={(event) => setJob(event.target.value)}
        />
        <ThinkingChoice label="Job thinking" value={effort} onChange={setEffort} />
        <Button type="submit" disabled={!valid}>
          Add
        </Button>
      </form>
    </div>
  );
}

// The tiers, per-job overrides and the cap, saved together.
function ModelSettingsForm({ onSaved }: { onSaved: () => void }) {
  const [draft, setDraft] = useState<ModelSettings | null>(null);
  const [capText, setCapText] = useState('');
  const [state, setState] = useState<{ saved: boolean; problem: string | null }>({
    saved: false,
    problem: null,
  });

  useEffect(() => {
    window.commander.models({ op: 'settings' }).then((response) => {
      if (!response.ok) return setState({ saved: false, problem: response.error });
      setDraft(response.result);
      setCapText(response.result.monthlyCapUsd === null ? '' : String(response.result.monthlyCapUsd));
    });
  }, []);

  if (!draft) return null;
  const change = (next: ModelSettings) => {
    setDraft(next);
    setState({ saved: false, problem: null });
  };
  const fallback = draft.deepFallback;

  async function save() {
    if (!draft) return;
    const cap = capText.trim() === '' ? null : Number(capText);
    const parsed = modelSettings.safeParse({ ...draft, monthlyCapUsd: cap });
    if (!parsed.success) {
      setState({
        saved: false,
        problem: `Those settings can't be saved: ${parsed.error.issues[0]?.message}`,
      });
      return;
    }
    const response = await window.commander.models({ op: 'save-settings', settings: parsed.data });
    if (!response.ok) return setState({ saved: false, problem: response.error });
    setDraft(response.result);
    setState({ saved: true, problem: null });
    onSaved();
  }

  return (
    <>
      {(['quick', 'deep'] as const).map((tier) => (
        <SettingRow
          key={tier}
          label={`${TIER_NAMES[tier]} tier`}
          description={
            tier === 'quick'
              ? 'Many small calls: sorting, filing, ranking. Thinking low by default.'
              : 'Fewer calls that need more care: drafts, summaries, meeting prep. Thinking high by default.'
          }
        >
          <TierFields
            tier={TIER_NAMES[tier]}
            setting={draft.tiers[tier]}
            onChange={(setting) => change({ ...draft, tiers: { ...draft.tiers, [tier]: setting } })}
          />
        </SettingRow>
      ))}
      <SettingRow
        label="Thinking per job"
        description="Give one job its own thinking level, over its tier's."
      >
        <JobOverrides
          overrides={draft.jobOverrides}
          onChange={(jobOverrides) => change({ ...draft, jobOverrides })}
        />
      </SettingRow>
      <SettingRow
        label="Monthly cap"
        description="Optional, in US dollars. At 80% Ares tells you in an Update; at the cap, Deep-tier jobs wait until next month (or use the fallback model) while Quick-tier jobs carry on."
      >
        <div className="grid max-w-[560px] gap-2">
          <Input
            data-testid="monthly-cap"
            aria-label="Monthly cap in US dollars"
            inputMode="decimal"
            placeholder="No cap"
            className="max-w-40"
            value={capText}
            onChange={(event) => {
              setCapText(event.target.value);
              setState({ saved: false, problem: null });
            }}
          />
          <Input
            aria-label="Deep fallback model"
            font="mono"
            className="normal-case"
            placeholder="Deep fallback model at the cap (none)"
            value={fallback?.model ?? ''}
            onChange={(event) => {
              const model = event.target.value;
              change({
                ...draft,
                deepFallback: model.trim() === '' ? null : { ...(fallback ?? draft.tiers.deep), model },
              });
            }}
          />
          {fallback && (
            <Input
              aria-label="Deep fallback base URL"
              font="mono"
              className="normal-case"
              value={fallback.baseUrl}
              onChange={(event) =>
                change({ ...draft, deepFallback: { ...fallback, baseUrl: event.target.value } })
              }
            />
          )}
        </div>
      </SettingRow>
      <SettingRow label="Save" description="Tiers, thinking and the cap take effect from the next call.">
        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={save} data-testid="model-settings-save">
            Save Ares settings
          </Button>
          {state.saved && (
            <span data-testid="model-settings-saved" className="text-note text-muted">
              Saved
            </span>
          )}
        </div>
        {state.problem && <Problem testId="model-settings-problem">{state.problem}</Problem>}
      </SettingRow>
    </>
  );
}

/** Settings → Ares: his API key, Test, the Quick and Deep tiers and the cap; then Usage. */
export function AresSettings({ no, usageNo }: { no: string; usageNo: string }) {
  const [usageVersion, refreshUsage] = useReducer((version: number) => version + 1, 0);
  return (
    <>
      <SettingsGroup no={no} title="Ares" note="Model · GLM-5.3-Flash via Z.ai" data-testid="ares-settings">
        <ApiKeyRow onChange={refreshUsage} />
        <TestRow onCall={refreshUsage} />
        <ModelSettingsForm onSaved={refreshUsage} />
      </SettingsGroup>
      <UsagePanel no={usageNo} version={usageVersion} />
    </>
  );
}
