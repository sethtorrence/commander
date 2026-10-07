// @vitest-environment jsdom
import { AppearanceProvider } from '@commander/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsProvider } from '../projects/context';
import type { ProjectsClient } from '../projects/projects';
import { FrameControlsProvider } from '../sections/section';
import { ShortcutProvider, useActiveScopes } from '../shortcuts/react';
import { pageOf, SETTINGS, SETTINGS_PAGES, settingsGroupId, showInSettings } from './pages';
import { SettingsLink } from './SettingsLink';
import { SettingsScreen } from './SettingsScreen';

// Settings in pages (#199): the sidebar, the page each group is on, the keys, and links that open
// Settings at a page or a group. Every group is the real one; the main process and the Core never
// answer (each bridge call waits forever), so each group shows as it does while loading.

// Anything on window.commander: callable (returning the same), awaitable (never settling), and
// usable as an unsubscribe function.
function never(): unknown {
  const target = () => undefined;
  return new Proxy(target, {
    get: (_, key) => (key === Symbol.toPrimitive ? () => '' : never()),
    apply: () => never(),
  });
}

const projects: ProjectsClient = {
  list: () => new Promise(() => {}),
  create: vi.fn(),
  change: vi.fn(),
  file: vi.fn(),
  settleFiling: vi.fn(),
};

function Active({ children }: { children: ReactNode }) {
  useActiveScopes([SETTINGS]);
  return children;
}

function renderSettings({ developer = false } = {}) {
  return render(
    <AppearanceProvider>
      <ShortcutProvider>
        <ProjectsProvider client={projects} storage={localStorage}>
          <Active>
            <SettingsScreen developer={developer} />
          </Active>
        </ProjectsProvider>
      </ShortcutProvider>
    </AppearanceProvider>,
  );
}

const nav = () => screen.getByRole('navigation', { name: 'Settings pages' });
const pageLink = (label: string) => within(nav()).getByRole('button', { name: new RegExp(`${label}$`) });
const pageElement = (id: string) => document.querySelector(`[data-settings-page="${id}"]`) as HTMLElement;
const openPage = () =>
  document.querySelector('[data-settings-page]:not([hidden])')?.getAttribute('data-settings-page');
const groupsOn = (id: string) =>
  [...pageElement(id).querySelectorAll('[data-settings-group]')].map((group) =>
    group.getAttribute('data-settings-group'),
  );
const title = () => screen.getByRole('heading', { level: 1 }).textContent;

const scrolledTo: string[] = [];

beforeEach(() => {
  vi.stubGlobal('commander', never());
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolledTo.push(this.getAttribute('data-settings-group') ?? '');
  };
  scrolledTo.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Settings in pages', () => {
  it('lists every page in the sidebar and opens on General, showing only its groups', () => {
    renderSettings();
    const links = within(nav()).getAllByRole('button');
    expect(links.map((link) => link.textContent)).toEqual(
      SETTINGS_PAGES.map((page, index) => `${String(index + 1).padStart(2, '0')}${page.label}`),
    );
    expect(pageLink('General').getAttribute('aria-current')).toBe('page');
    expect(openPage()).toBe('general');
    expect(title()).toBe('General');
    expect(screen.getAllByRole('region').map((group) => group.getAttribute('data-settings-group'))).toEqual(
      expect.arrayContaining(['appearance', 'start-up']),
    );
  });

  it('shows only the page chosen, at its top, with its name as the title', () => {
    renderSettings();
    fireEvent.click(pageLink('Accounts'));
    expect(openPage()).toBe('accounts');
    expect(pageElement('general').hidden).toBe(true);
    expect(pageLink('Accounts').getAttribute('aria-current')).toBe('page');
    expect(pageLink('General').getAttribute('aria-current')).toBeNull();
    expect(title()).toBe('Accounts');
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0 });

    fireEvent.click(pageLink('Data'));
    expect(groupsOn('data')).toEqual(['snapshots', 'export', 'markdown-copy']);
    expect(within(pageElement('data')).getByText('Markdown copy folder')).toBeTruthy();
  });

  it('puts every group on the page the list says, and lists every group it shows', () => {
    renderSettings({ developer: true });
    // Email's own group shows once there is an email Account, which there never is here.
    const listed = (groups: readonly string[]) => groups.filter((group) => group !== 'email');
    for (const page of SETTINGS_PAGES) expect(groupsOn(page.id)).toEqual(listed(page.groups));
    // Every group on the sheet is one of those.
    const shown = [...document.querySelectorAll('[data-settings-group]')].map((group) =>
      group.getAttribute('data-settings-group'),
    );
    expect(shown).toEqual(listed(SETTINGS_PAGES.flatMap((page) => page.groups)));
  });

  it('shows the Design gallery only in development builds', () => {
    renderSettings({ developer: false });
    expect(groupsOn('general')).toEqual(['appearance', 'start-up']);
    expect(screen.queryByRole('link', { name: /design gallery/i })).toBeNull();
    cleanup();
    renderSettings({ developer: true });
    expect(groupsOn('general')).toEqual(['appearance', 'start-up', 'design']);
    expect(screen.getByRole('link', { name: /design gallery/i }).getAttribute('href')).toBe('#/design');
  });

  it('moves between pages from the keyboard: Tab stops on the open page, the arrows, Home and End move', () => {
    renderSettings();
    const general = pageLink('General');
    expect(general.tabIndex).toBe(0);
    expect(pageLink('Accounts').tabIndex).toBe(-1);

    general.focus();
    fireEvent.keyDown(general, { key: 'ArrowDown' });
    expect(openPage()).toBe('accounts');
    expect(document.activeElement).toBe(pageLink('Accounts'));
    expect(pageLink('Accounts').tabIndex).toBe(0);

    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(openPage()).toBe('diagnostics');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(openPage()).toBe('diagnostics');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' });
    expect(openPage()).toBe('security');
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    expect(openPage()).toBe('general');
    expect(document.activeElement).toBe(general);
  });

  it('has j and k for the next and previous page while Settings is open', () => {
    renderSettings();
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(openPage()).toBe('accounts');
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(openPage()).toBe('ares');
    fireEvent.keyDown(document.body, { key: 'k' });
    fireEvent.keyDown(document.body, { key: 'k' });
    fireEvent.keyDown(document.body, { key: 'k' });
    expect(openPage()).toBe('general');
  });
});

describe('opening Settings at a page or group', () => {
  it('opens the page a group is on and scrolls to the group', async () => {
    renderSettings();
    act(() => showInSettings({ group: 'buckets' }));
    expect(openPage()).toBe('email');
    await waitFor(() => expect(scrolledTo).toEqual(['buckets']));

    act(() => showInSettings({ group: 'accounts' }));
    expect(openPage()).toBe('accounts');
    await waitFor(() => expect(scrolledTo).toEqual(['buckets', 'accounts']));
  });

  it('opens a page at its top', async () => {
    renderSettings();
    act(() => showInSettings({ page: 'ares' }));
    expect(openPage()).toBe('ares');
    expect(title()).toBe('Ares');
    await waitFor(() => expect(window.scrollTo).toHaveBeenCalledWith({ top: 0 }));
    expect(scrolledTo).toEqual([]);
  });

  it('knows the page of every group a link may name', () => {
    expect(pageOf('accounts')).toBe('accounts');
    expect(pageOf('usage')).toBe('ares');
    expect(pageOf('rules')).toBe('projects');
    expect(pageOf('buckets')).toBe('email');
    expect(pageOf('markdown-copy')).toBe('data');
    expect(settingsGroupId('Start-up')).toBe('start-up');
    expect(settingsGroupId('Markdown copy')).toBe('markdown-copy');
  });

  it('opens Settings through the frame from a link in running text', () => {
    const openSettings = vi.fn();
    render(
      <FrameControlsProvider value={{ openSection: vi.fn(), openSettings, setTabCount: vi.fn() }}>
        <p>
          Connect one in <SettingsLink to={{ group: 'accounts' }}>Settings → Accounts</SettingsLink>.
        </p>
      </FrameControlsProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Settings → Accounts' }));
    expect(openSettings).toHaveBeenCalledWith({ group: 'accounts' });
  });
});
