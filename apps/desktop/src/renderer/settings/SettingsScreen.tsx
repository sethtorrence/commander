import {
  Button,
  ButtonGroup,
  cn,
  SectionHeader,
  Sheet,
  SignalColourPicker,
  THEMES,
  useAppearance,
} from '@commander/ui';
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { BucketsSettings } from '../buckets/BucketsSettings';
import { partNumber } from '../frame/calendar';
import { useReveal } from '../frame/reveal';
import { useNow } from '../frame/use-now';
import { PeopleSettings } from '../people/PeopleSettings';
import { ProjectsSettings } from '../projects/ProjectsSettings';
import { RulesSettings } from '../rules/RulesSettings';
import { EmailSettings } from '../sections/email/EmailSettings';
import { DailyTemplateSettings } from '../sections/notes/DailyTemplateSettings';
import { TeamsSettings } from '../sections/teams/TeamsSettings';
import { useShortcuts } from '../shortcuts/react';
import { AccountsPanel } from './AccountsPanel';
import { AutonomyPanel } from './AutonomyPanel';
import { AresSettings } from './ares/AresSettings';
import { CalendarSettings } from './CalendarSettings';
import { ExportSettings, MarkdownCopySettings, SnapshotSettings } from './DataSettings';
import { Diagnostics } from './Diagnostics';
import { GitHubWatchPanel } from './github/GitHubWatchPanel';
import { SETTINGS, SETTINGS_PAGES, type SettingsPageId } from './pages';
import { SettingRow, SettingsGroup } from './parts';
import { SecurityPanel } from './SecurityPanel';
import { StartAtLogin } from './StartAtLogin';

const THEME_NAMES = { dark: 'Dark', light: 'Light' } as const;
const pad = (n: number) => String(n).padStart(2, '0');
const isPage = (id: string): id is SettingsPageId => SETTINGS_PAGES.some((page) => page.id === id);

function ThemeChoice() {
  const { theme, setTheme } = useAppearance();
  return (
    <ButtonGroup role="radiogroup" aria-label="Theme">
      {THEMES.map((option) => (
        <Button
          key={option}
          role="radio"
          aria-checked={theme === option}
          variant={theme === option ? 'primary' : 'default'}
          onClick={() => setTheme(option)}
        >
          {THEME_NAMES[option]}
        </Button>
      ))}
    </ButtonGroup>
  );
}

/**
 * The sidebar of pages. Tab reaches the open page's button; ↑ and ↓ (Home, End) move between pages,
 * opening each as they go, like the notebook tabs' number keys.
 */
function SettingsNav({ page, onChoose }: { page: SettingsPageId; onChoose: (page: SettingsPageId) => void }) {
  const list = useRef<HTMLUListElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const at = SETTINGS_PAGES.findIndex((each) => each.id === page);
    const to =
      event.key === 'ArrowDown'
        ? Math.min(at + 1, SETTINGS_PAGES.length - 1)
        : event.key === 'ArrowUp'
          ? Math.max(at - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? SETTINGS_PAGES.length - 1
              : null;
    const next = to === null ? undefined : SETTINGS_PAGES[to];
    if (!next) return;
    event.preventDefault();
    onChoose(next.id);
    list.current?.querySelector<HTMLButtonElement>(`[data-settings-page-link="${next.id}"]`)?.focus();
  };
  return (
    <nav
      aria-label="Settings pages"
      className="sticky top-(--body) max-h-[calc(100vh-var(--body))] self-start overflow-y-auto"
    >
      <ul ref={list} className="m-0 list-none p-0" onKeyDown={onKeyDown}>
        {SETTINGS_PAGES.map((each, index) => {
          const current = each.id === page;
          return (
            <li key={each.id}>
              <button
                type="button"
                data-settings-page-link={each.id}
                aria-current={current ? 'page' : undefined}
                // One stop for Tab: the open page; the arrows reach the rest.
                tabIndex={current ? 0 : -1}
                onClick={() => onChoose(each.id)}
                className={cn(
                  'relative flex h-9 w-full cursor-pointer items-center border-0 border-b border-line2 bg-transparent pr-3 pl-10 text-left font-sans text-note text-text hover:bg-raise',
                  current && 'bg-raise font-semibold text-ink shadow-[inset_3px_0_0_var(--ink)]',
                )}
              >
                <span
                  aria-hidden="true"
                  className="absolute left-0 w-10 text-center font-mono text-label font-semibold tracking-normal text-muted"
                >
                  {pad(index + 1)}
                </span>
                {each.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** One page's groups, kept mounted (so they keep their state) and hidden while another page is open. */
function SettingsPageView({
  id,
  page,
  children,
}: {
  id: SettingsPageId;
  page: SettingsPageId;
  children: ReactNode;
}) {
  return (
    <div data-settings-page={id} hidden={id !== page}>
      {children}
    </div>
  );
}

/**
 * Settings, opened from the header (or `,`) as a temporary tab, in pages (pages.ts): the sidebar
 * picks one, and links open it at a group (`showInSettings`, through the reveal channel). `open`
 * while it is on screen. `developer` (development builds) adds the Design gallery's group.
 */
export function SettingsScreen({
  open = true,
  developer = import.meta.env.DEV,
}: {
  open?: boolean;
  developer?: boolean;
}) {
  const today = useNow(60_000);
  const [page, setPage] = useState<SettingsPageId>('general');
  // Where to scroll once the page asked for is on screen: a group, or the top.
  const [target, setTarget] = useState<{ group: string | null } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useReveal(SETTINGS, (pageId, group) => {
    if (!isPage(pageId)) return;
    setPage(pageId);
    setTarget({ group: group ?? null });
  });
  // As soon as the page is on screen, before anything a group asks for next (People centring a
  // Person, say).
  useLayoutEffect(() => {
    if (!target || !open) return;
    const group =
      target.group &&
      root.current?.querySelector(`[data-settings-page="${page}"] [data-settings-group="${target.group}"]`);
    if (group) group.scrollIntoView({ block: 'start' });
    else window.scrollTo({ top: 0 });
    setTarget(null);
  }, [target, open, page]);

  const choose = (next: SettingsPageId) => {
    setPage(next);
    window.scrollTo({ top: 0 });
  };
  const step = (by: number) => {
    const at = SETTINGS_PAGES.findIndex((each) => each.id === page);
    const next = SETTINGS_PAGES[at + by];
    if (next) choose(next.id);
  };
  useShortcuts([
    { keys: 'j', label: 'Next Settings page', group: 'Settings', scope: SETTINGS, run: () => step(1) },
    { keys: 'k', label: 'Previous Settings page', group: 'Settings', scope: SETTINGS, run: () => step(-1) },
  ]);

  const index = SETTINGS_PAGES.findIndex((each) => each.id === page);
  const current = SETTINGS_PAGES[index] ?? SETTINGS_PAGES[0];
  const shown = (id: SettingsPageId) => open && page === id;
  return (
    <Sheet
      data-testid="settings"
      className="col-span-8 mr-4 ml-3.5 min-h-[calc(100vh-var(--body))] border-t-0 pb-27.5"
    >
      <SectionHeader
        eyebrow="Settings"
        partNumber={partNumber('SET', today)}
        sheet={[index + 1, SETTINGS_PAGES.length]}
        title={current.label}
        subtitle={
          <>
            <b>{current.summary}</b> · kept on this machine
          </>
        }
      />
      <div ref={root} className="grid grid-cols-[200px_minmax(0,1fr)] items-start">
        <SettingsNav page={page} onChoose={choose} />
        <div className="min-h-[calc(100vh-var(--body))] min-w-0 border-l border-line">
          <SettingsPageView id="general" page={page}>
            <SettingsGroup no="01" title="Appearance" note="Theme · signal colour">
              <SettingRow
                label="Theme"
                description="Graphite (dark) or concrete (light). Also on the tabs’ right edge."
              >
                <ThemeChoice />
              </SettingRow>
              <SettingRow
                label="Signal colour"
                description="The colour of live things and of Ares. Adjusted per theme so it stays legible."
              >
                <SignalColourPicker className="max-w-[820px]" />
              </SettingRow>
            </SettingsGroup>
            <SettingsGroup no="02" title="Start-up" note="Tray">
              <StartAtLogin />
            </SettingsGroup>
            {developer && (
              <SettingsGroup no="03" title="Design" note="Industrial design system · development builds">
                <SettingRow label="Design gallery" description="Every token and component, dark and light.">
                  <Button asChild>
                    <a href="#/design" className="no-underline">
                      Open the design gallery →
                    </a>
                  </Button>
                </SettingRow>
              </SettingsGroup>
            )}
          </SettingsPageView>
          <SettingsPageView id="accounts" page={page}>
            <AccountsPanel no="01" />
          </SettingsPageView>
          <SettingsPageView id="ares" page={page}>
            <AresSettings no="01" usageNo="02" />
          </SettingsPageView>
          <SettingsPageView id="autonomy" page={page}>
            <AutonomyPanel no="01" shown={shown('autonomy')} />
          </SettingsPageView>
          <SettingsPageView id="projects" page={page}>
            <ProjectsSettings no="01" />
            <RulesSettings no="02" shown={shown('projects')} />
          </SettingsPageView>
          <SettingsPageView id="people" page={page}>
            <PeopleSettings no="01" />
          </SettingsPageView>
          <SettingsPageView id="notes" page={page}>
            <DailyTemplateSettings no="01" />
          </SettingsPageView>
          <SettingsPageView id="email" page={page}>
            <EmailSettings no="01" shown={shown('email')} />
            <BucketsSettings no="02" shown={shown('email')} />
          </SettingsPageView>
          <SettingsPageView id="calendar" page={page}>
            <CalendarSettings no="01" />
          </SettingsPageView>
          <SettingsPageView id="github" page={page}>
            <GitHubWatchPanel no="01" />
          </SettingsPageView>
          <SettingsPageView id="teams" page={page}>
            <TeamsSettings no="01" shown={shown('teams')} />
          </SettingsPageView>
          <SettingsPageView id="data" page={page}>
            <SnapshotSettings no="01" />
            <ExportSettings no="02" />
            <MarkdownCopySettings no="03" />
          </SettingsPageView>
          <SettingsPageView id="security" page={page}>
            <SecurityPanel no="01" />
          </SettingsPageView>
          <SettingsPageView id="diagnostics" page={page}>
            <Diagnostics no="01" />
          </SettingsPageView>
        </div>
      </div>
    </Sheet>
  );
}
