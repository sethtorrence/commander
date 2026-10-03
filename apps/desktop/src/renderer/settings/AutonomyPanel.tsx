import {
  ACTION_KIND_NAMES,
  type ActionKind,
  AUTONOMY_LEVEL_NAMES,
  AUTONOMY_SECTION_NAMES,
  type AutonomyLevel,
  type AutonomyState,
  type AutonomyTarget,
  actionKinds,
  autonomyLevels,
  autonomySections,
  isAllowed,
} from '@commander/domain';
import { cn, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from '@commander/ui';
import { useEffect, useState } from 'react';
import { SettingsGroup } from './parts';

// Who sees the result of each Action kind, and its hard limit where it has one.
const KIND_NOTES: Record<ActionKind, string> = {
  organise: 'Only inside Commander: ranking, filing, suggesting Todos, drafting',
  'tidy-sources': 'In your own Accounts, unseen by others: labels, archiving, marking read',
  'act-for-you': 'Seen by other people: replies, Linear comments, RSVPs. Never above Ask',
  delete: 'Permanent or hard to undo. Never above Ask, and never in bulk',
};

const SAME = 'same';

type AutonomyClient = Window['commander']['autonomy'];

/**
 * Settings → Autonomy: the grid of what Ares may do on his own. The four Action kinds down the side,
 * Everywhere and each Section across; under each kind, the actions Ares's jobs have registered, each
 * with an optional level of its own. Levels above a kind's hard limit are greyed out. Reloaded each
 * time Settings opens, so newly registered actions show.
 */
export function AutonomyPanel({
  no,
  shown,
  client = window.commander.autonomy,
}: {
  no: string;
  shown: boolean;
  client?: AutonomyClient;
}) {
  const [state, setState] = useState<AutonomyState | null>(null);

  useEffect(() => {
    if (!shown) return;
    let current = true;
    client({ op: 'settings' }).then((next) => current && setState(next), report);
    return () => {
      current = false;
    };
  }, [client, shown]);

  const set = (target: AutonomyTarget, level: AutonomyLevel | null) =>
    client({ op: 'set-level', target, level }).then(setState, report);

  return (
    <SettingsGroup no={no} title="Autonomy" note="What Ares may do on his own">
      <p className="m-0 border-b border-line2 py-3 pr-6 pl-13 text-note leading-[19px] text-muted">
        <b className="text-ink">Off</b>: he leaves it alone. <b className="text-ink">Ask</b>: he suggests it
        on the Item and waits for you. <b className="text-ink">Auto when sure</b>: he does it when he’s
        confident and asks otherwise. <b className="text-ink">Auto</b>: he does it. Everything he does is
        logged on his activity page and can be undone. Something he suggests because of another Item always
        asks.
      </p>
      <div className="overflow-x-auto py-3 pr-6 pl-13">
        <table aria-label="Autonomy settings" className="w-full border-collapse text-left">
          <thead>
            <tr className="font-mono text-label leading-none font-semibold uppercase tracking-label text-muted">
              <th scope="col" className="w-56 border-b border-line pb-2 font-semibold">
                Action kind
              </th>
              <th scope="col" className="border-b border-line px-1 pb-2 font-semibold text-ink">
                Everywhere
              </th>
              {autonomySections.map((section) => (
                <th key={section} scope="col" className="border-b border-line px-1 pb-2 font-semibold">
                  {AUTONOMY_SECTION_NAMES[section]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state &&
              actionKinds.map((kind) => {
                const name = ACTION_KIND_NAMES[kind];
                const actions = state.actions.filter((action) => action.actionKind === kind);
                return [
                  <tr key={kind} className="align-top">
                    <th scope="row" className="border-t border-line2 py-2 pr-3 font-normal">
                      <span className="block text-row leading-[22px] font-semibold text-ink">{name}</span>
                      <span className="block text-note leading-[17px] text-muted">{KIND_NOTES[kind]}</span>
                    </th>
                    <td className="border-t border-line2 px-1 py-2">
                      <LevelSelect
                        label={`${name} · Everywhere`}
                        kind={kind}
                        value={state.settings.everywhere[kind]}
                        overrides={false}
                        onChange={(level) => set({ scope: 'everywhere', actionKind: kind }, level)}
                      />
                    </td>
                    {autonomySections.map((section) => (
                      <td key={section} className="border-t border-line2 px-1 py-2">
                        <LevelSelect
                          label={`${name} · ${AUTONOMY_SECTION_NAMES[section]}`}
                          kind={kind}
                          value={state.settings.sections[section]?.[kind] ?? null}
                          onChange={(level) => set({ scope: 'section', section, actionKind: kind }, level)}
                        />
                      </td>
                    ))}
                  </tr>,
                  ...actions.map((action) => (
                    <tr key={action.action} className="align-top" data-testid="registered-action">
                      <th scope="row" className="py-1.5 pr-3 pl-4 font-normal">
                        <span className="block text-note leading-[19px] font-semibold text-text">
                          {action.name}
                        </span>
                        {action.hint && (
                          <span className="block text-note leading-[17px] text-muted">{action.hint}</span>
                        )}
                      </th>
                      <td className="px-1 py-1.5">
                        <LevelSelect
                          label={action.name}
                          kind={kind}
                          value={state.settings.actions[action.action] ?? null}
                          onChange={(level) => set({ scope: 'action', action: action.action }, level)}
                        />
                      </td>
                      <td
                        colSpan={autonomySections.length}
                        className="px-1 py-1.5 align-middle text-note leading-[17px] text-faint"
                      >
                        Overrides {name} everywhere
                      </td>
                    </tr>
                  )),
                ];
              })}
          </tbody>
        </table>
        {state && !state.actions.length && (
          <p className="m-0 mt-2 text-note text-faint">
            No actions registered yet. Each of Ares’s jobs lists its actions here when it starts.
          </p>
        )}
      </div>
    </SettingsGroup>
  );
}

/** One cell: a level, or (for a Section or an action) the same as the level it overrides. */
function LevelSelect({
  label,
  kind,
  value,
  onChange,
  overrides = true,
}: {
  label: string;
  kind: ActionKind;
  value: AutonomyLevel | null;
  onChange: (level: AutonomyLevel | null) => void;
  /** Whether the cell can follow the level it overrides (Sections and actions; not Everywhere). */
  overrides?: boolean;
}) {
  return (
    <Select
      value={value ?? SAME}
      onValueChange={(next) => onChange(next === SAME ? null : (next as AutonomyLevel))}
    >
      <SelectTrigger aria-label={label} className={cn('min-w-28', value === null && 'text-faint')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {overrides && <SelectItem value={SAME}>Same</SelectItem>}
        {autonomyLevels.map((level) => (
          <SelectItem key={level} value={level} disabled={!isAllowed(kind, level)}>
            {AUTONOMY_LEVEL_NAMES[level]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function report(error: unknown) {
  toast(error instanceof Error ? error.message : String(error));
}
