import { describeRule, type Rule } from '@commander/domain';
import { Badge, Button, cn } from '@commander/ui';
import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { ItemStoreClient } from '../item-store/client';
import { useProjects } from '../projects/context';
import { SettingRow, SettingsGroup } from '../settings/parts';
import { type RuleFlow, useRuleFlow } from './rule-flow';
import { rulesIn } from './rules';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Settings → Rules: the one list of Rules, checked from the top (the first match files the Item), with
 * drag (or the arrows) to reorder, edit and delete, and New Rule. `shown` while Settings is on screen:
 * the list is read again each time it comes back, for Rules changed on a Project page meanwhile.
 */
export function RulesSettings({
  no,
  shown = true,
  itemStore = window.commander.itemStore,
}: {
  no: string;
  shown?: boolean;
  itemStore?: ItemStoreClient;
}) {
  const client = useMemo(() => rulesIn(itemStore), [itemStore]);
  const flow = useRuleFlow(client);
  const { reload } = flow;
  const wasShown = useRef(shown);
  useEffect(() => {
    if (shown && !wasShown.current) reload();
    wasShown.current = shown;
  }, [shown, reload]);

  return (
    <SettingsGroup no={no} title="Rules" note={`${pad(flow.rules.length)} Rules · first match wins`}>
      {flow.rules.length ? (
        <RuleList flow={flow} />
      ) : (
        flow.loaded && (
          <p className="hatch m-0 border-b border-line2 py-3 pr-5 pl-13 text-heading text-faint">
            No Rules yet. Items from your Sources stay where you or Ares file them.
          </p>
        )
      )}
      <SettingRow
        label="New Rule"
        description="Conditions on what a Source says about an Item (a Linear team, label or title) and the Project they file it into."
      >
        <Button variant="primary" onClick={() => flow.edit(null)}>
          New Rule
        </Button>
      </SettingRow>
      {flow.ui}
    </SettingsGroup>
  );
}

const rowClass =
  'relative grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 border-b border-line2 py-2 pr-6 pl-13';

function RuleList({ flow }: { flow: RuleFlow }) {
  const { projectById } = useProjects();
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const { rules } = flow;

  const moveTo = (rule: Rule, to: number) => {
    const index = rules.findIndex((other) => other.id === rule.id);
    const position = Math.max(0, Math.min(rules.length - 1, to));
    if (index === position) return;
    flow.move(rule, position);
  };

  const dropAt = (event: DragEvent, index: number) => {
    event.preventDefault();
    const id = dragged ?? event.dataTransfer.getData('text/plain');
    setDragged(null);
    setOver(null);
    const rule = rules.find((other) => other.id === id);
    if (rule) moveTo(rule, index);
  };

  return (
    <ol aria-label="Rules" className="m-0 list-none p-0">
      {rules.map((rule, index) => {
        const project = projectById(rule.target.projectId);
        const text = describeRule(rule.when);
        return (
          <li
            key={rule.id}
            draggable
            onDragStart={(event) => {
              setDragged(rule.id);
              event.dataTransfer.setData('text/plain', rule.id);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => {
              setDragged(null);
              setOver(null);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(index);
            }}
            onDrop={(event) => dropAt(event, index)}
            className={cn(
              rowClass,
              'cursor-grab',
              dragged === rule.id && 'opacity-45',
              over === index && dragged !== rule.id && 'shadow-[inset_0_2px_0_var(--ink)]',
            )}
          >
            <span
              className="absolute left-0 w-10 text-center font-mono text-label font-medium text-faint"
              title="Drag to reorder: the first match from the top wins"
            >
              {pad(index + 1)}
            </span>
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="truncate text-row leading-[22px] font-semibold text-ink">{text}</span>
              <span aria-hidden="true" className="text-muted">
                →
              </span>
              {project ? (
                <Badge code={project.code} accent={project.accent} project={project.name} />
              ) : (
                <Badge kind="unfiled" />
              )}
            </span>
            <span className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Move ${text} up`}
                disabled={index === 0}
                onClick={() => moveTo(rule, index - 1)}
              >
                ↑
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Move ${text} down`}
                disabled={index === rules.length - 1}
                onClick={() => moveTo(rule, index + 1)}
              >
                ↓
              </Button>
            </span>
            <span className="flex items-center gap-1">
              <Button size="sm" onClick={() => flow.edit(rule)} aria-label={`Edit ${text}`}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => flow.remove(rule)}
                aria-label={`Delete ${text}`}
              >
                Delete
              </Button>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
