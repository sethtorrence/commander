import { useMemo } from 'react';
import { itemChangesFromCore } from '../../item-store/changes';
import type { SectionDefinition } from '../section';
import { LinearSheet } from './LinearSheet';
import { linearAccountsIn, linearIssuesIn } from './linear-issues';

// The Linear Section: every Linear issue in every connected workspace, opening on those assigned to
// the User, filtered, opened into a detail pane and filed into Projects. It reaches the app only
// through linear-issues.ts, via the window's bridge.
function LinearSection() {
  const issues = useMemo(() => linearIssuesIn(window.commander.itemStore), []);
  const accounts = useMemo(() => linearAccountsIn(window.commander), []);
  return <LinearSheet issues={issues} accounts={accounts} changes={itemChangesFromCore} />;
}

export const linear: SectionDefinition = {
  id: 'linear',
  label: 'Linear',
  code: 'LIN',
  Component: LinearSection,
};
