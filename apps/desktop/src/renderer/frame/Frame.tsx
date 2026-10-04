import { DrawingGrid, RulerX, RulerY } from '@commander/ui';
import { type ComponentProps, type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import { PaletteHost } from '../palette/PaletteHost';
import { ProjectsProvider, useProjects } from '../projects/context';
import { PROJECT_PAGE_SCOPE, ProjectPage } from '../projects/page/ProjectPage';
import { ProjectPageTab } from '../projects/page/ProjectPageTab';
import { type ProjectsClient, projectsIn } from '../projects/projects';
import { SECTIONS, type SectionDefinition } from '../sections';
import { DashboardProvider, useDashboard } from '../sections/dashboard/context';
import { type DashboardClient, dashboardIn } from '../sections/dashboard/dashboard';
import { linearAccountsIn } from '../sections/linear/linear-issues';
import { FrameControlsProvider, HeaderSlotProvider, SectionProvider } from '../sections/section';
import { SettingsScreen } from '../settings/SettingsScreen';
import { ShortcutScope, useActiveScopes, useShortcuts } from '../shortcuts/react';
import { isTypingTarget } from '../shortcuts/registry';
import { CheatSheet } from './CheatSheet';
import { Header } from './Header';
import { NotebookTabs } from './NotebookTabs';
import { RulerCursor } from './RulerCursor';

const SETTINGS = 'settings';
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
 * What the whole window shares: the Projects with the one Project filter, and the Dashboard's ranked
 * list (read by the Dashboard, the header's band meter and the Project pages).
 */
function FrameProviders({
  projects,
  onOpenPage,
  dashboard,
  open,
  children,
}: {
  projects: ProjectsClient;
  onOpenPage: (projectId: string) => void;
  dashboard: DashboardClient;
  open: string;
  children: ReactNode;
}) {
  return (
    <ProjectsProvider client={projects} onOpenPage={onOpenPage}>
      <DashboardProvider client={dashboard} open={open}>
        {children}
      </DashboardProvider>
    </ProjectsProvider>
  );
}

/**
 * The header, naming the open Project page's Project when one is shown, with the Dashboard's band
 * counts on its meter. A band opens the Dashboard at that band.
 */
function FrameHeader({ page, onBand, ...props }: ComponentProps<typeof Header> & { page: string | null }) {
  const project = useProjects().projectById(page ?? '');
  const { counts, jumpToBand } = useDashboard();
  const shown = project && { eyebrow: `Project / ${project.code}`, title: project.name };
  return (
    <Header
      {...props}
      {...shown}
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
    () => dashboardIn(window.commander.itemStore, linearAccountsIn(window.commander)),
    [],
  );
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);
  // The open Project page (a temporary tab), and where Esc or × on it goes back to.
  const [page, setPage] = useState<string | null>(null);
  const [returnTo, setReturnTo] = useState(open);
  const openNow = useRef(open);
  openNow.current = open;

  const openSection = useCallback((id: string) => {
    setOpen(id);
    setLastSection(id);
    window.scrollTo({ top: 0 });
  }, []);
  const openSettings = useCallback(() => {
    setOpen(SETTINGS);
    window.scrollTo({ top: 0 });
  }, []);
  const closeSettings = useCallback(() => openSection(lastSection), [openSection, lastSection]);

  const openPage = useCallback((projectId: string) => {
    if (openNow.current !== PROJECT_PAGE_SCOPE) setReturnTo(openNow.current);
    setPage(projectId);
    setOpen(PROJECT_PAGE_SCOPE);
    window.scrollTo({ top: 0 });
  }, []);
  const showPage = useCallback(() => {
    if (openNow.current !== PROJECT_PAGE_SCOPE) setReturnTo(openNow.current);
    setOpen(PROJECT_PAGE_SCOPE);
  }, []);
  const closePage = useCallback(() => {
    setPage(null);
    if (openNow.current !== PROJECT_PAGE_SCOPE) return;
    if (returnTo === SETTINGS) openSettings();
    else openSection(returnTo);
  }, [returnTo, openSettings, openSection]);
  const back = useMemo(
    () => ({
      label: SECTIONS.find((section) => section.id === returnTo)?.label ?? 'Settings',
      onClick: closePage,
    }),
    [returnTo, closePage],
  );

  // The counts Sections put on their tabs (useTabCount).
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const setTabCount = useCallback(
    (id: string, count: number | null) =>
      setCounts((now) => (now[id] === count ? now : { ...now, [id]: count })),
    [],
  );
  const controls = useMemo(() => ({ openSection, setTabCount }), [openSection, setTabCount]);

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
      dashboard={dashboard}
      open={open === PROJECT_PAGE_SCOPE ? `${open}:${page}` : open}
    >
      <DrawingGrid className="fixed top-(--top) right-0 bottom-0 left-(--rul)" />
      <FrameHeader
        {...header}
        page={open === PROJECT_PAGE_SCOPE ? page : null}
        onBand={() => openSection('dashboard')}
        slotRef={setHeaderSlot}
        ares={{ onOpen: () => openSection('ares') }}
      />
      <RulerX className="fixed top-(--hdr) right-0 left-0 z-24" />
      <RulerY className="fixed top-(--top) bottom-0 left-0 z-24" />
      <RulerCursor />
      <NotebookTabs
        sections={SECTIONS}
        open={open}
        counts={counts}
        onOpen={openSection}
        onOpenSettings={openSettings}
        onCloseSettings={closeSettings}
        temporary={
          page && (
            <ProjectPageTab
              projectId={page}
              current={open === PROJECT_PAGE_SCOPE}
              onOpen={showPage}
              onClose={closePage}
            />
          )
        }
      />
      <main className="relative z-1 ml-(--rul) pt-(--body)">
        <FrameControlsProvider value={controls}>
          <HeaderSlotProvider value={headerSlot}>
            {SECTIONS.map((section, i) => (
              <SectionView key={section.id} section={section} number={i + 1} open={open === section.id} />
            ))}
          </HeaderSlotProvider>
        </FrameControlsProvider>
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
              />
            </ShortcutScope>
          </section>
        )}
        <section className="grid grid-cols-8" hidden={open !== SETTINGS} aria-label="Settings">
          <SettingsScreen open={open === SETTINGS} />
        </section>
      </main>
      <CheatSheet open={cheatSheet} onOpenChange={setCheatSheet} />
      <PaletteHost
        current={open}
        onOpenSection={openSection}
        onOpenSettings={openSettings}
        onToggleShortcuts={() => setCheatSheet((shown) => !shown)}
      />
    </FrameProviders>
  );
}
