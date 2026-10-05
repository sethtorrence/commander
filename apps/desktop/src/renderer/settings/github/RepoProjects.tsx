import { type GitHubRepoRef, githubRepoRule, githubRepoWhen } from '@commander/domain';
import { Badge, Button } from '@commander/ui';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { ItemStoreClient } from '../../item-store/client';
import { useProjects, useProjectsIfAny } from '../../projects/context';
import { useRuleFlow } from '../../rules/rule-flow';
import { rulesIn } from '../../rules/rules';

/*
  Settings → GitHub's Projects column (#118): beside each watched repo, the Project its own Rule
  ("repo is acme/titanlink-api", alone) files it into, and Map to Project…, which opens that Rule in
  the Rule editor, or a new one naming the repo with its Project to choose. A shortcut into the one
  Rules list, not a second way of filing: what it saves is a Rule like any other, in its place.
*/

type RepoProjects = { column: (repo: GitHubRepoRef) => ReactNode };

const RepoProjectsContext = createContext<RepoProjects | null>(null);

/** The Projects column for a repo's row, or nothing outside a <RepoProjectsProvider> with Projects. */
export function RepoProjectsCell({ repo }: { repo: GitHubRepoRef }) {
  return useContext(RepoProjectsContext)?.column(repo) ?? null;
}

/** Gives the repo rows below their Projects column, when the window has Projects to file into. */
export function RepoProjectsProvider({
  itemStore,
  children,
}: {
  itemStore: ItemStoreClient;
  children: ReactNode;
}) {
  if (!useProjectsIfAny()) return children;
  return <WithRules itemStore={itemStore}>{children}</WithRules>;
}

function WithRules({ itemStore, children }: { itemStore: ItemStoreClient; children: ReactNode }) {
  const client = useMemo(() => rulesIn(itemStore), [itemStore]);
  const flow = useRuleFlow(client);
  const { projectById } = useProjects();
  const { rules, edit } = flow;
  const value = useMemo<RepoProjects>(
    () => ({
      column(repo) {
        const name = `${repo.owner}/${repo.name}`;
        const rule = githubRepoRule(rules, repo.nodeId);
        const project = rule?.target.kind === 'project' ? projectById(rule.target.projectId) : undefined;
        return (
          <span className="flex shrink-0 items-center gap-2">
            {project && <Badge code={project.code} accent={project.accent} project={project.name} />}
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Map ${name} to a Project`}
              title={rule ? 'Edit the Rule filing this repo' : 'Make a Rule filing this repo into a Project'}
              onClick={() => (rule ? edit(rule) : edit(null, undefined, { when: githubRepoWhen(repo) }))}
            >
              Map to Project…
            </Button>
          </span>
        );
      },
    }),
    [rules, edit, projectById],
  );
  return (
    <RepoProjectsContext.Provider value={value}>
      {children}
      {flow.ui}
    </RepoProjectsContext.Provider>
  );
}
