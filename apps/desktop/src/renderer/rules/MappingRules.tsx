import { describeRule, type Project } from '@commander/domain';
import { Badge, Button } from '@commander/ui';
import { useEffect, useMemo, useRef } from 'react';
import type { ItemStoreClient } from '../item-store/client';
import { SideCard } from '../projects/page/SideCard';
import { useRuleFlow } from './rule-flow';
import { rulesIn } from './rules';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A Project page's Mapping Rules: the Rules that file Items into the Project, each with its place in
 * the one list, opening in the Rule editor; and New Rule, starting on this Project. `active` while the
 * page is shown (the Rules are read again when it comes back); `onChanged` after Items moved.
 */
export function MappingRules({
  project,
  itemStore,
  active,
  onChanged,
}: {
  project: Project;
  itemStore: ItemStoreClient;
  active: boolean;
  onChanged: () => void;
}) {
  const client = useMemo(() => rulesIn(itemStore), [itemStore]);
  const flow = useRuleFlow(client, onChanged);
  const { reload } = flow;
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) reload();
    wasActive.current = active;
  }, [active, reload]);
  const own = flow.rules.filter((rule) => rule.target.projectId === project.id);

  return (
    <SideCard
      label="Mapping Rules"
      title={
        <>
          <Badge size="sm" code={project.code} accent={project.accent} project={project.name} />
          Mapping Rules
        </>
      }
      note={pad(own.length)}
    >
      {own.length ? (
        <ol aria-label="Rules filing into this Project" className="m-0 list-none p-0">
          {own.map((rule) => (
            <li key={rule.id} className="border-b border-line2">
              <button
                type="button"
                onClick={() => flow.edit(rule)}
                title="Open in the Rule editor"
                className="flex w-full cursor-pointer items-baseline gap-2 border-0 bg-transparent px-2.5 py-1.5 text-left text-note leading-[18px] text-ink hover:bg-raise"
              >
                <span className="flex-none font-mono text-label text-faint">{pad(rule.order + 1)}</span>
                <span className="min-w-0">{describeRule(rule.when)}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        flow.loaded && (
          <p className="m-0 border-b border-line2 px-2.5 py-2 text-note leading-[18px] text-muted">
            No Rules file into {project.code} yet.
          </p>
        )
      )}
      <div className="px-2.5 py-2.5">
        <Button size="sm" onClick={() => flow.edit(null, project.id)}>
          New Rule for {project.code}
        </Button>
      </div>
      {flow.ui}
    </SideCard>
  );
}
