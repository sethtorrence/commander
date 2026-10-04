import { cn, Kbd } from '@commander/ui';
import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { useReveal } from '../../frame/reveal';
import { useNow } from '../../frame/use-now';
import { PickBadgeProvider, useBadgePicker } from '../../projects/BadgePicker';
import { SectionProjectFilter } from '../../projects/badges';
import { useProjectFilter, useProjects } from '../../projects/context';
import { useShortcuts } from '../../shortcuts/react';
import { EmptySheet, SectionSheet, useOpenSection, useSection, useTabCount } from '../section';
import { sectionFor } from '../todos/links';
import { TodoGroup } from '../todos/TodoGroup';
import { IssueDetail } from './IssueDetail';
import { IssueRow } from './IssueRow';
import { isMine } from './issues';
import { IssueFilterBar, ViewSwitch } from './ListControls';
import { type IssueLink, type LinearAccountsClient, type LinearIssues, syncLine } from './linear-issues';
import { useLinear } from './use-linear';

// Enter opens the selected issue, except on a control that Enter presses (a button, a link).
const onPressable = () => !!document.activeElement?.closest('button, a[href], summary, [role="button"]');

const KEYS: [ReactNode, string][] = [
  [
    <>
      <Kbd>J</Kbd>
      <Kbd>K</Kbd>
    </>,
    'Move',
  ],
  [<Kbd key="enter">↵</Kbd>, 'Open'],
  [<Kbd key="b">B</Kbd>, 'Project'],
  [<Kbd key="z">Ctrl Z</Kbd>, 'Undo'],
];

/** The Section's main keys at a glance, beside its title. All of them are in the `?` cheat sheet. */
function Keys() {
  return (
    <div className="grid grid-cols-[auto_auto] gap-x-3.5 gap-y-[5px] pb-0.5 font-mono text-label leading-[19px] font-medium uppercase tracking-label whitespace-nowrap text-muted [&_kbd]:h-[17px] [&_kbd]:min-w-[17px] [&_kbd]:text-label">
      {KEYS.map(([caps, label]) => (
        <span key={label} className="flex items-center gap-[7px]">
          {caps} {label}
        </span>
      ))}
    </div>
  );
}

const and = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/**
 * The Linear Section's sheet, after the prototype's Section pattern: the sheet header, the Project
 * filter, the view switch (Assigned to me, All tickets) with the sync status line, the Linear
 * filters, then the list grouped by workflow state and, once an issue is opened, the detail pane.
 * Opening the Section asks every Linear Account to sync.
 */
export function LinearSheet({ issues, accounts }: { issues: LinearIssues; accounts: LinearAccountsClient }) {
  const { filter, include } = useProjectFilter();
  const { projects } = useProjects();
  const filtered = projects.find((project) => project.id === filter);
  const now = useNow(60_000);
  const state = useLinear({ issues, accounts, include, now: now.getTime() });
  const { selected, detailOpen, setDetailOpen, groups, accountsById } = state;
  const badges = useBadgePicker(state.apply, state.undo);
  const openSection = useOpenSection();
  const several = state.accounts.length > 1;

  useTabCount(state.loaded ? state.assignedCount : null);
  useRefreshWhenOpened(state.refresh, state.reload);

  const file = () =>
    selected &&
    badges.open({
      id: selected.id,
      title: `${selected.detail.identifier} ${selected.title}`,
      filing: selected.filing,
    });

  const openLink = ({ other }: IssueLink) => {
    if (other.deletedAt !== null) return;
    const section = sectionFor(other.kind);
    if (section && section !== 'linear') openSection(section);
    else if (other.kind === 'linear-issue') state.select(other.id);
  };

  const openIssue = (itemId: string) => {
    state.select(itemId);
    setDetailOpen(true);
  };

  useShortcuts([
    { keys: 'j', label: 'Next issue', run: () => state.moveSelection(1) },
    { keys: 'k', label: 'Previous issue', run: () => state.moveSelection(-1) },
    { keys: 'Enter', label: 'Open the issue', when: () => !onPressable(), run: () => setDetailOpen(true) },
    { keys: 'Escape', label: 'Close the issue', when: () => detailOpen, run: () => setDetailOpen(false) },
    { keys: 'b', label: 'File under a Project', run: () => file() },
    { keys: 'Ctrl+z', label: 'Undo', run: () => state.undo() },
  ]);
  // From the palette: open an issue it found, whatever the view and filters were hiding.
  useReveal('linear', (itemId) => state.reveal(itemId));

  const workspaces = state.accounts.map((account) => account.name);
  const status = syncLine(state.accounts, now);
  const syncing = state.accounts.some((account) => account.sync?.activity === 'syncing');
  const closed = groups.find((group) => group.id === 'closed');
  let number = 0;

  return (
    <SectionSheet
      span="full"
      subtitle={
        <>
          <b>{state.openCount} open</b> {state.view === 'mine' ? 'assigned to you' : 'in all tickets'}
          {filter !== 'everything' && ` ${filtered ? `in ${filtered.name}` : 'Unfiled'}`}
          {workspaces.length > 0 &&
            ` · ${and(workspaces)} ${workspaces.length === 1 ? 'workspace' : 'workspaces'}`}
        </>
      }
      aside={<Keys />}
      className="flex flex-col"
    >
      <SectionProjectFilter items={state.forProjectFilter} />
      <ViewSwitch
        view={state.view}
        counts={state.viewCounts}
        onView={state.setView}
        status={{ ...status, syncing }}
      />
      <IssueFilterBar
        filters={state.filters}
        options={state.options}
        onFilter={state.setFilter}
        onClear={state.clearFilters}
      />
      {state.loaded && state.accounts.length === 0 && groups.every((group) => !group.issues.length) ? (
        <EmptySheet>No Linear Account connected yet. Connect one in Settings → Accounts (,).</EmptySheet>
      ) : (
        <PickBadgeProvider value={badges.open}>
          <div className={cn('flex-1', detailOpen && 'grid grid-cols-[minmax(0,9fr)_minmax(0,7fr)]')}>
            <div className="min-w-0 pb-30">
              {groups.map((group, index) => {
                const isClosed = group.id === 'closed';
                const first = number + 1;
                if (!isClosed || state.closedShown) number += group.issues.length;
                return (
                  <TodoGroup
                    key={group.id}
                    no={`G${index + 1}`}
                    title={group.title}
                    count={group.issues.length}
                    expanded={isClosed ? state.closedShown : true}
                    onExpandedChange={isClosed ? state.showClosed : undefined}
                  >
                    {group.issues.length ? (
                      <ul className="m-0 list-none p-0">
                        {group.issues.map((issue, i) => (
                          <IssueRow
                            key={issue.id}
                            issue={issue}
                            number={first + i}
                            selected={issue.id === selected?.id}
                            mine={isMine(issue, accountsById)}
                            workspace={
                              several && issue.account
                                ? (accountsById.get(issue.account)?.name ?? null)
                                : null
                            }
                            compact={detailOpen}
                            onOpen={() => openIssue(issue.id)}
                          />
                        ))}
                      </ul>
                    ) : (
                      !isClosed && <EmptyGroup>Nothing here.</EmptyGroup>
                    )}
                  </TodoGroup>
                );
              })}
              {closed && !closed.issues.length && state.closedShown && (
                <EmptyGroup>No issues closed in the last 30 days.</EmptyGroup>
              )}
            </div>
            {detailOpen && (
              <IssueDetail
                issue={selected}
                mine={!!selected && isMine(selected, accountsById)}
                workspace={selected?.account ? (accountsById.get(selected.account)?.name ?? null) : null}
                links={state.links}
                history={state.history}
                onFile={file}
                onClose={() => setDetailOpen(false)}
                onOpenLink={openLink}
              />
            )}
          </div>
        </PickBadgeProvider>
      )}
      {badges.picker}
    </SectionSheet>
  );
}

function EmptyGroup({ children }: { children: ReactNode }) {
  return <p className="hatch m-0 border-b border-line2 py-2.5 pr-5 pl-13 text-note text-faint">{children}</p>;
}

// Opening the Section asks every Linear Account to sync (the sync engine's refresh); the issues are
// read again whenever it comes into view or the window regains focus, for filing done elsewhere.
function useRefreshWhenOpened(refresh: () => void, reload: () => void) {
  const { active } = useSection();
  const wasActive = useRef(false);
  useEffect(() => {
    if (active && !wasActive.current) {
      refresh();
      reload();
    }
    wasActive.current = active;
  }, [active, refresh, reload]);
  const onFocus = useCallback(() => reload(), [reload]);
  useEffect(() => {
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [onFocus]);
}
