import { useMemo } from 'react';
import { itemChangesFromCore } from '../../item-store/changes';
import type { SectionDefinition } from '../section';
import { GitHubSheet } from './GitHubSheet';
import { githubAccountsIn, githubWorkIn } from './github-work';
import { oversightIn } from './oversight';

// The GitHub Section (#115): pull requests and issues across the watched repos, filtered, opened into
// a detail pane with their discussion, and filed into Projects, under the oversight summary (#119). It reaches the app only through
// github-work.ts, via the window's bridge. GitHub is read-only in v1.
function GitHubSection() {
  const work = useMemo(() => githubWorkIn(window.commander.itemStore, window.commander), []);
  const accounts = useMemo(() => githubAccountsIn(window.commander), []);
  // The oversight summary at the top (#119), worked out by the Core.
  const oversight = useMemo(() => oversightIn(window.commander.itemStore), []);
  return <GitHubSheet work={work} accounts={accounts} changes={itemChangesFromCore} oversight={oversight} />;
}

export const github: SectionDefinition = {
  id: 'github',
  label: 'GitHub',
  code: 'GH',
  Component: GitHubSection,
};
