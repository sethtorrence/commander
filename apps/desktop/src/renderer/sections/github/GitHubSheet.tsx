import { waitingOn } from '@commander/domain';
import { cn, Kbd } from '@commander/ui';
import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { useReveal } from '../../frame/reveal';
import { useNow } from '../../frame/use-now';
import type { ItemChanges } from '../../item-store/changes';
import { PickBadgeProvider, useBadgePicker } from '../../projects/BadgePicker';
import { SectionProjectFilter } from '../../projects/badges';
import { useProjectFilter, useProjects } from '../../projects/context';
import { useShortcuts } from '../../shortcuts/react';
import { syncLine } from '../linear/linear-issues';
import { EmptySheet, SectionSheet, useOpenSection, useSection, useTabCount } from '../section';
import { sectionFor } from '../todos/links';
import { TodoGroup } from '../todos/TodoGroup';
import type { GitHubAccountsClient, GitHubWork, WorkLink } from './github-work';
import { ViewSwitch, WorkFilterBar } from './ListControls';
import { OversightPanel } from './OversightPanel';
import { type OversightClient, targetOf } from './oversight';
import { useGitHub } from './use-github';
import { WorkDetail } from './WorkDetail';
import { WorkRow } from './WorkRow';
import { identifierOf, isPullRequest, type Work, type YourWork } from './work';

// Enter opens the selected one, except on a control that Enter presses (a button, a link).
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
 * The GitHub Section's sheet, after the prototype's Section pattern: the sheet header, the Project
 * filter, the view switch (Pull requests, Issues) with the sync status line, the GitHub filters, then
 * the list (open first, Closed collapsed) and, once one is opened, the detail pane with its
 * discussion. Opening the Section asks every GitHub Account to sync.
 *
 * Your work (#116) is the default view: the User's pull requests, the reviews asked of them and the
 * issues assigned to them.
 *
 * Above the view switch, the oversight summary (#119) when given its `oversight` client: each of its
 * lines opens its Items here. The People view (#122) joins the Section later.
 */
export function GitHubSheet({
  work,
  accounts,
  changes,
  oversight,
}: {
  work: GitHubWork;
  accounts: GitHubAccountsClient;
  /** Word of Items changed elsewhere (Ares filing a pull request, say), so the list catches up. */
  changes?: ItemChanges;
  /** The oversight summaries, from the Core. */
  oversight?: OversightClient;
}) {
  const { filter, include } = useProjectFilter();
  const { projects, openPage } = useProjects();
  const filtered = projects.find((project) => project.id === filter);
  const now = useNow(60_000);
  const state = useGitHub({ work, accounts, include, changes });
  const { selected, detailOpen, setDetailOpen, groups } = state;
  const badges = useBadgePicker(state.apply, state.undo);
  const openSection = useOpenSection();

  // Direct review requests, and the User's pull requests failing checks or with changes requested.
  useTabCount(state.loaded && state.tabCount ? state.tabCount : null);
  useRefreshWhenOpened(state.refresh, state.reload);

  const file = () =>
    selected &&
    badges.open({
      id: selected.id,
      title: `${identifierOf(selected)} ${selected.title}`,
      filing: selected.filing,
      filingSuggestion: selected.filingSuggestion,
    });

  const openLink = ({ other }: WorkLink) => {
    if (other.kind === 'project') return openPage?.(other.id);
    if (other.deletedAt !== null) return;
    const section = sectionFor(other.kind);
    if (section && section !== 'github') openSection(section);
    else if (section === 'github') state.reveal(other.id);
  };

  const openWork = (itemId: string) => {
    state.select(itemId);
    setDetailOpen(true);
  };

  useShortcuts([
    { keys: 'j', label: 'Next pull request or issue', run: () => state.moveSelection(1) },
    { keys: 'k', label: 'Previous pull request or issue', run: () => state.moveSelection(-1) },
    { keys: 'Enter', label: 'Open it', when: () => !onPressable(), run: () => setDetailOpen(true) },
    { keys: 'Escape', label: 'Close it', when: () => detailOpen, run: () => setDetailOpen(false) },
    { keys: 'b', label: 'File under a Project', run: () => file() },
    { keys: 'Ctrl+z', label: 'Undo', run: () => state.undo() },
  ]);
  // From the palette (or a Link): open a pull request or issue, whatever the view and filters hid.
  useReveal('github', (itemId) => state.reveal(itemId));

  const logins = state.accounts.map((account) => account.login);
  const status = syncLine(state.accounts, now, 'No GitHub Account connected');
  const syncing = state.accounts.some((account) => account.sync?.activity === 'syncing');
  const closed = groups.find((group) => group.id === 'closed');
  const noun = { mine: 'in your work', pulls: 'pull requests', issues: 'issues' }[state.view];
  let number = 0;

  return (
    <SectionSheet
      span="full"
      subtitle={
        <>
          <b>{state.openCount} open</b> {noun}
          {filter !== 'everything' && ` ${filtered ? `in ${filtered.name}` : 'Unfiled'}`}
          {logins.length > 0 && ` · signed in as ${and(logins)}`}
        </>
      }
      aside={<Keys />}
      className="flex flex-col"
    >
      <SectionProjectFilter items={state.forProjectFilter} />
      {oversight && (
        <OversightPanel
          client={oversight}
          accounts={accounts}
          changes={changes}
          onOpen={(line) => {
            const target = targetOf(line);
            if (target.kind === 'item') state.reveal(target.itemId);
            else if (target.kind === 'items') state.showOnly(target.itemIds, target.label);
            else {
              state.clearFilters();
              state.setFilter('repo', target.repo);
            }
          }}
        />
      )}
      <ViewSwitch
        view={state.view}
        counts={state.viewCounts}
        onView={state.setView}
        status={{ ...status, syncing }}
      />
      <WorkFilterBar
        filters={state.filters}
        options={state.options}
        onFilter={state.setFilter}
        onClear={state.clearFilters}
      />
      {state.only && (
        <p
          role="status"
          data-testid="github-only"
          className="m-0 flex h-9 flex-none items-center gap-3 border-b border-line bg-raise pr-4 pl-[41px] text-note text-text"
        >
          <span className="min-w-0 flex-1 truncate">
            Showing {state.only.itemIds.size} from the summary: {state.only.label}
          </span>
          <button
            type="button"
            onClick={state.showAll}
            className="cursor-pointer border-0 bg-transparent font-mono text-label leading-none font-medium uppercase tracking-label whitespace-nowrap text-muted hover:text-ink"
          >
            Show all
          </button>
        </p>
      )}
      {state.loaded && state.accounts.length === 0 && !state.allWork.length ? (
        <EmptySheet>No GitHub Account connected yet. Connect one in Settings → Accounts (,).</EmptySheet>
      ) : (
        <PickBadgeProvider value={badges.open}>
          <div className={cn('flex-1', detailOpen && 'grid grid-cols-[minmax(0,9fr)_minmax(0,7fr)]')}>
            <div className="min-w-0 pb-30">
              {groups.map((group, index) => {
                const isClosed = group.id === 'closed';
                const first = number + 1;
                if (!isClosed || state.closedShown) number += group.work.length;
                return (
                  <TodoGroup
                    key={group.id}
                    no={`G${index + 1}`}
                    title={group.title}
                    count={group.work.length}
                    expanded={isClosed ? state.closedShown : true}
                    onExpandedChange={isClosed ? state.showClosed : undefined}
                  >
                    {group.work.length ? (
                      <ul className="m-0 list-none p-0">
                        {group.work.map((each, i) => (
                          <WorkRow
                            key={each.id}
                            work={each}
                            number={first + i}
                            selected={each.id === selected?.id}
                            now={now.getTime()}
                            reviewAsked={state.reviewAsked.has(each.id)}
                            note={noteFor(state.yourWork(each), each)}
                            compact={detailOpen}
                            onOpen={() => openWork(each.id)}
                          />
                        ))}
                      </ul>
                    ) : (
                      !isClosed && <EmptyGroup>Nothing open here.</EmptyGroup>
                    )}
                  </TodoGroup>
                );
              })}
              {closed && !closed.work.length && state.closedShown && (
                <EmptyGroup>Nothing merged or closed lately.</EmptyGroup>
              )}
            </div>
            {detailOpen && (
              <WorkDetail
                work={selected}
                all={state.allWork}
                links={state.links}
                history={state.history}
                discussion={state.discussion}
                onFile={file}
                onClose={() => setDetailOpen(false)}
                onOpenLink={openLink}
                onRemoveLink={(link) => {
                  const from = selected?.id;
                  if (from) void state.apply(() => work.unlink(from, link));
                }}
                onOpenWork={state.reveal}
              />
            )}
          </div>
        </PickBadgeProvider>
      )}
      {badges.picker}
    </SectionSheet>
  );
}

// What a row in Your work adds: who the User's pull request waits on, or the team a review was asked of.
function noteFor(where: YourWork | null, work: Work): string | undefined {
  if (where?.group === 'reviews' && !where.direct)
    return where.teams.length ? where.teams.map((team) => `@${team}`).join(', ') : 'Your team';
  if (where?.group !== 'your-pulls' || !isPullRequest(work)) return undefined;
  const waiting = waitingOn(work.detail);
  return waiting.length ? `Waiting on ${waiting.join(', ')}` : undefined;
}

function EmptyGroup({ children }: { children: ReactNode }) {
  return <p className="hatch m-0 border-b border-line2 py-2.5 pr-5 pl-13 text-note text-faint">{children}</p>;
}

// Opening the Section asks every GitHub Account to sync (the sync engine's refresh); the work is read
// again whenever it comes into view or the window regains focus, for filing done elsewhere.
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
