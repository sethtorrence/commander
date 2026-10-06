import { DrawingGrid, RulerX, RulerY } from '@commander/ui';
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { itemChangesFromCore } from '../item-store/changes';
import { PaletteHost } from '../palette/PaletteHost';
import { PeopleProvider, usePeople } from '../people/context';
import { PERSON_PAGE_SCOPE, PersonPage } from '../people/PersonPage';
import { PersonPageTab } from '../people/PersonPageTab';
import { peopleIn } from '../people/people';
import { ProjectsProvider, useProjects } from '../projects/context';
import { PROJECT_PAGE_SCOPE, ProjectPage } from '../projects/page/ProjectPage';
import { ProjectPageTab } from '../projects/page/ProjectPageTab';
import { type ProjectsClient, projectsIn } from '../projects/projects';
import { SECTIONS, type SectionDefinition } from '../sections';
import { FindTimeHost } from '../sections/calendar/FindTime';
import { DashboardProvider, useDashboard } from '../sections/dashboard/context';
import { type DashboardClient, dashboardAccountsIn, dashboardIn } from '../sections/dashboard/dashboard';
import { peopleViewIn } from '../sections/github/people';
import { FrameControlsProvider, HeaderSlotProvider, SectionProvider } from '../sections/section';
import { SETTINGS, type SettingsPlace, showInSettings } from '../settings/pages';
import { SettingsScreen } from '../settings/SettingsScreen';
import { ShortcutScope, useActiveScopes, useShortcuts } from '../shortcuts/react';
import { isTypingTarget } from '../shortcuts/registry';
import { UpdatesProvider, useUpdates } from '../updates/context';
import type { OpenTarget } from '../updates/updates';
import { CheatSheet } from './CheatSheet';
import { CoreBanner } from './CoreBanner';
import { Header } from './Header';
import { NotebookTabs } from './NotebookTabs';
import { RulerCursor } from './RulerCursor';
import { requestReveal } from './reveal';
import { useAresStatus } from './use-ares-status';

const pad = (n: number) => String(n).padStart(2, '0');

function SectionView({
  section,
  number,
  open,
}: {
  section: SectionDefinition;
  number: number;
  open: boolean;
}) {
  const place = useMemo(
    () => ({ definition: section, number, total: SECTIONS.length, active: open }),
    [section, number, open],
  );
  return (
    <section className="grid grid-cols-8" hidden={!open} aria-label={section.label}>
      <SectionProvider place={place}>
        <ShortcutScope scope={section.id} group={section.label}>
          <section.Component />
        </ShortcutScope>
      </SectionProvider>
    </section>
  );
}

/**
 * What the whole window shares: the Projects with the one Project filter, People (who each handle
 * in an Item is, for every row and pane that shows people), the Dashboard's ranked
 * list (read by the Dashboard, the header's band meter and the Project pages), and Ares's Updates
 * (the quiet count, and the Update the User asks for).
 */
function FrameProviders({
  projects,
  onOpenPage,
  onOpenPerson,
  dashboard,
  open,
  onOpenUpdateLine,
  children,
}: {
  projects: ProjectsClient;
  onOpenPage: (projectId: string) => void;
  onOpenPerson: (personId: string) => void;
  dashboard: DashboardClient;
  open: string;
  onOpenUpdateLine: (target: OpenTarget) => void;
  children: ReactNode;
}) {
  const people = useMemo(() => peopleIn(window.commander.itemStore), []);
  return (
    <PeopleProvider client={people} changes={itemChangesFromCore} onOpenPerson={onOpenPerson}>
      <ProjectsProvider client={projects} onOpenPage={onOpenPage}>
        <DashboardProvider client={dashboard} open={open}>
          <UpdatesProvider
            client={window.commander.updates}
            onCoreMessage={window.commander.onCoreMessage}
            onAskForUpdate={window.commander.onAskForUpdate}
            onOpen={onOpenUpdateLine}
          >
            {children}
          </UpdatesProvider>
        </DashboardProvider>
      </ProjectsProvider>
    </PeopleProvider>
  );
}

/**
 * The header, naming the open Project page's Project when one is shown, with the Dashboard's band
 * counts on its meter. A band opens the Dashboard at that band.
 */
function FrameHeader({
  page,
  person,
  onBand,
  ...props
}: ComponentProps<typeof Header> & { page: string | null; person: string | null }) {
  const project = useProjects().projectById(page ?? '');
  const someone = usePeople().people.find((each) => each.id === person);
  const { counts, jumpToBand } = useDashboard();
  const updates = useUpdates();
  const shown =
    (project && { eyebrow: `Project / ${project.code}`, title: project.name }) ||
    (someone && { eyebrow: 'Person', title: someone.name });
  const away = !!updates.presence && updates.presence.state !== 'active';
  return (
    <Header
      {...props}
      {...shown}
      ares={{
        ...props.ares,
        queued: updates.queued,
        presence: away ? 'away' : 'here',
        awaySince: away && updates.presence ? new Date(updates.presence.since) : undefined,
        onAsk: updates.ask,
      }}
      bands={counts}
      onBand={(band) => {
        onBand?.(band);
        if (band === 'now' || band === 'today' || band === 'waiting' || band === 'fyi') jumpToBand(band);
      }}
    />
  );
}

/**
 * The app frame: the Industrial header, the rulers and exposed grid, the numbered notebook tabs,
 * and the open Section's sheet. Sections stay mounted while another is open, so they keep their
 * state. The frame's own keys: 1–9 open Sections; `,` Settings, `?` the cheat sheet, `Ctrl+K` and `/`
 * the palette come with it (palette/PaletteHost.tsx). It also holds
 * the Projects and the one Project filter every Section shares (projects/context.tsx).
 */
export function Frame() {
  const [open, setOpen] = useState<string>(SECTIONS[0]?.id ?? SETTINGS);
  const [lastSection, setLastSection] = useState(open);
  const [cheatSheet, setCheatSheet] = useState(false);
  const projects = useMemo(() => projectsIn(window.commander.itemStore), []);
  const dashboard = useMemo(
    () => dashboardIn(window.commander.itemStore, dashboardAccountsIn(window.commander), window.commander),
    [],
  );
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);
  const aresWork = useAresStatus();
  // The open Project page (a temporary tab), and where Esc or × on it goes back to.
  const [page, setPage] = useState<string | null>(null);
  const [returnTo, setReturnTo] = useState(open);
  // The open Person's page (#122, a temporary tab too), and where it goes back to.
  const [person, setPerson] = useState<string | null>(null);
  const [personReturnTo, setPersonReturnTo] = useState(open);
  const openNow = useRef(open);
  openNow.current = open;
  // Where a page goes back to: where the User was, or (from the other page) where that one goes back to.
  const backTargets = useRef({ project: returnTo, person: personReturnTo });
  backTargets.current = { project: returnTo, person: personReturnTo };
  const cameFrom = () =>
    openNow.current === PERSON_PAGE_SCOPE
      ? backTargets.current.person
      : openNow.current === PROJECT_PAGE_SCOPE
        ? backTargets.current.project
        : openNow.current;
  const people = useMemo(() => peopleViewIn(window.commander.itemStore, window.commander.updates), []);

  const openSection = useCallback((id: string) => {
    setOpen(id);
    setLastSection(id);
    window.scrollTo({ top: 0 });
  }, []);
  // Settings, on the page the User left it at, or at a page or group (settings/pages.ts).
  const openSettings = useCallback((place?: SettingsPlace) => {
    setOpen(SETTINGS);
    window.scrollTo({ top: 0 });
    if (place) showInSettings(place);
  }, []);
  const closeSettings = useCallback(() => openSection(lastSection), [openSection, lastSection]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: cameFrom reads refs only
  const openPage = useCallback((projectId: string) => {
    if (openNow.current !== PROJECT_PAGE_SCOPE) setReturnTo(cameFrom());
    setPage(projectId);
    setOpen(PROJECT_PAGE_SCOPE);
    window.scrollTo({ top: 0 });
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: cameFrom reads refs only
  const showPage = useCallback(() => {
    if (openNow.current !== PROJECT_PAGE_SCOPE) setReturnTo(cameFrom());
    setOpen(PROJECT_PAGE_SCOPE);
  }, []);
  const closePage = useCallback(() => {
    setPage(null);
    if (openNow.current !== PROJECT_PAGE_SCOPE) return;
    if (returnTo === SETTINGS) openSettings();
    else openSection(returnTo);
  }, [returnTo, openSettings, openSection]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: cameFrom reads refs only
  const openPerson = useCallback((personId: string) => {
    if (openNow.current !== PERSON_PAGE_SCOPE) setPersonReturnTo(cameFrom());
    setPerson(personId);
    setOpen(PERSON_PAGE_SCOPE);
    window.scrollTo({ top: 0 });
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: cameFrom reads refs only
  const showPerson = useCallback(() => {
    if (openNow.current !== PERSON_PAGE_SCOPE) setPersonReturnTo(cameFrom());
    setOpen(PERSON_PAGE_SCOPE);
  }, []);
  const closePerson = useCallback(() => {
    setPerson(null);
    if (openNow.current !== PERSON_PAGE_SCOPE) return;
    if (personReturnTo === SETTINGS) openSettings();
    else openSection(personReturnTo);
  }, [personReturnTo, openSettings, openSection]);
  // Open on a line of an Update: its Item where it lives, its Section, or Settings at the group it is
  // about (Accounts, for an Account to reconnect).
  const openUpdateLine = useCallback(
    (target: OpenTarget) => {
      if (target.kind === 'settings') return openSettings({ group: target.group });
      openSection(target.sectionId);
      if (target.kind === 'item') requestReveal(target.sectionId, target.itemId, target.focus);
      // A place in a Section rather than an Item (the Email Section's Unsorted view, #141).
      if (target.kind === 'section' && target.focus) requestReveal(target.sectionId, '', target.focus);
    },
    [openSettings, openSection],
  );
  // A meeting's heads-up was clicked (the main process shows the window): its event, in Calendar.
  useEffect(
    () =>
      window.commander.onOpenItem?.(({ sectionId, itemId }) => {
        openSection(sectionId);
        requestReveal(sectionId, itemId);
      }),
    [openSection],
  );
  const back = useMemo(
    () => ({
      label: SECTIONS.find((section) => section.id === returnTo)?.label ?? 'Settings',
      onClick: closePage,
    }),
    [returnTo, closePage],
  );
  const personBack = useMemo(
    () => ({
      label: SECTIONS.find((section) => section.id === personReturnTo)?.label ?? 'Settings',
      onClick: closePerson,
    }),
    [personReturnTo, closePerson],
  );

  // The counts Sections put on their tabs (useTabCount).
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const setTabCount = useCallback(
    (id: string, count: number | null) =>
      setCounts((now) => (now[id] === count ? now : { ...now, [id]: count })),
    [],
  );
  const controls = useMemo(
    () => ({ openSection, openSettings, setTabCount }),
    [openSection, openSettings, setTabCount],
  );

  useActiveScopes([open]);
  useShortcuts([
    ...SECTIONS.slice(0, 9).map((section, index) => ({
      keys: String(index + 1),
      label: section.label,
      group: 'Sections',
      run: () => openSection(section.id),
    })),
    {
      keys: 'Escape',
      label: 'Leave the field',
      group: 'General',
      inFields: true,
      when: () => isTypingTarget(document.activeElement),
      run: () => (document.activeElement as HTMLElement | null)?.blur(),
    },
    { keys: 'Escape', label: 'Close Settings', group: 'Settings', scope: SETTINGS, run: closeSettings },
  ]);

  const index = SECTIONS.findIndex((section) => section.id === open);
  const current = SECTIONS[index];
  const header = current
    ? { eyebrow: `Sec ${pad(index + 1)} / ${current.label}`, title: current.headerTitle ?? current.label }
    : { eyebrow: 'Commander / Settings', title: 'Settings' };

  return (
    <FrameProviders
      projects={projects}
      onOpenPage={openPage}
      onOpenPerson={openPerson}
      dashboard={dashboard}
      open={open === PROJECT_PAGE_SCOPE ? `${open}:${page}` : open}
      onOpenUpdateLine={openUpdateLine}
    >
      <DrawingGrid className="fixed top-(--top) right-0 bottom-0 left-(--rul)" />
      <FrameHeader
        {...header}
        page={open === PROJECT_PAGE_SCOPE ? page : null}
        person={open === PERSON_PAGE_SCOPE ? person : null}
        onBand={() => openSection('dashboard')}
        slotRef={setHeaderSlot}
        ares={{ working: aresWork, onOpen: () => openSection('ares') }}
      />
      <RulerX className="fixed top-(--hdr) right-0 left-0 z-24" />
      <RulerY className="fixed top-(--top) bottom-0 left-0 z-24" />
      <RulerCursor />
      <NotebookTabs
        sections={SECTIONS}
        open={open}
        counts={counts}
        onOpen={openSection}
        onOpenSettings={() => openSettings()}
        onCloseSettings={closeSettings}
        temporary={
          <>
            {page && (
              <ProjectPageTab
                projectId={page}
                current={open === PROJECT_PAGE_SCOPE}
                onOpen={showPage}
                onClose={closePage}
              />
            )}
            {person && (
              <PersonPageTab
                personId={person}
                current={open === PERSON_PAGE_SCOPE}
                onOpen={showPerson}
                onClose={closePerson}
              />
            )}
          </>
        }
      />
      <main className="relative z-1 ml-(--rul) pt-(--body)">
        {/* Settings may open a Section too (What Ares knows, from Settings → Ares). */}
        <FrameControlsProvider value={controls}>
          <HeaderSlotProvider value={headerSlot}>
            {SECTIONS.map((section, i) => (
              <SectionView key={section.id} section={section} number={i + 1} open={open === section.id} />
            ))}
          </HeaderSlotProvider>
          {page && (
            <section
              className="grid grid-cols-8"
              hidden={open !== PROJECT_PAGE_SCOPE}
              aria-label="Project page"
            >
              <ShortcutScope scope={PROJECT_PAGE_SCOPE} group="Project page">
                <ProjectPage
                  projectId={page}
                  active={open === PROJECT_PAGE_SCOPE}
                  itemStore={window.commander.itemStore}
                  back={back}
                  onOpenSection={openSection}
                  changes={itemChangesFromCore}
                />
              </ShortcutScope>
            </section>
          )}
          {person && (
            <section
              className="grid grid-cols-8"
              hidden={open !== PERSON_PAGE_SCOPE}
              aria-label="Person page"
            >
              <ShortcutScope scope={PERSON_PAGE_SCOPE} group="Person page">
                <PersonPage
                  personId={person}
                  active={open === PERSON_PAGE_SCOPE}
                  client={people}
                  back={personBack}
                  onOpenSection={openSection}
                  onOpenSettings={openSettings}
                  changes={itemChangesFromCore}
                />
              </ShortcutScope>
            </section>
          )}
          <section className="grid grid-cols-8" hidden={open !== SETTINGS} aria-label="Settings">
            <SettingsScreen open={open === SETTINGS} />
          </section>
          {/* Within the frame's controls: its Diagnostics link opens that Settings page. */}
          <CoreBanner />
        </FrameControlsProvider>
      </main>
      <CheatSheet open={cheatSheet} onOpenChange={setCheatSheet} />
      <FindTimeHost />
      <PaletteHost
        current={open}
        onOpenSection={openSection}
        onOpenSettings={openSettings}
        onToggleShortcuts={() => setCheatSheet((shown) => !shown)}
      />
    </FrameProviders>
  );
}
