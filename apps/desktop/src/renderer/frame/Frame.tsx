import { DrawingGrid, RulerX, RulerY } from '@commander/ui';
import { useCallback, useMemo, useState } from 'react';
import { ProjectsProvider } from '../projects/context';
import { projectsIn } from '../projects/projects';
import { SECTIONS, type SectionDefinition } from '../sections';
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
 * The app frame: the Industrial header, the rulers and exposed grid, the numbered notebook tabs,
 * and the open Section's sheet. Sections stay mounted while another is open, so they keep their
 * state. The frame's own keys: 1–9 open Sections, `,` Settings, `?` the cheat sheet. It also holds
 * the Projects and the one Project filter every Section shares (projects/context.tsx).
 */
export function Frame() {
  const [open, setOpen] = useState<string>(SECTIONS[0]?.id ?? SETTINGS);
  const [lastSection, setLastSection] = useState(open);
  const [cheatSheet, setCheatSheet] = useState(false);
  const projects = useMemo(() => projectsIn(window.commander.itemStore), []);
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);

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
      keys: '?',
      label: 'Keyboard shortcuts',
      group: 'General',
      inDialogs: true,
      run: () => setCheatSheet((shown) => !shown),
    },
    { keys: ',', label: 'Settings', group: 'General', run: openSettings },
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
    <ProjectsProvider client={projects}>
      <DrawingGrid className="fixed top-(--top) right-0 bottom-0 left-(--rul)" />
      <Header
        {...header}
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
      />
      <main className="relative z-1 ml-(--rul) pt-(--body)">
        <FrameControlsProvider value={controls}>
          <HeaderSlotProvider value={headerSlot}>
            {SECTIONS.map((section, i) => (
              <SectionView key={section.id} section={section} number={i + 1} open={open === section.id} />
            ))}
          </HeaderSlotProvider>
        </FrameControlsProvider>
        <section className="grid grid-cols-8" hidden={open !== SETTINGS} aria-label="Settings">
          <SettingsScreen open={open === SETTINGS} />
        </section>
      </main>
      <CheatSheet open={cheatSheet} onOpenChange={setCheatSheet} />
    </ProjectsProvider>
  );
}
