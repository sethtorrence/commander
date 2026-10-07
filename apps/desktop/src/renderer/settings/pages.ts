import { requestReveal } from '../frame/reveal';

/*
  Settings in pages (#199): a sidebar lists the pages, and choosing one shows only its groups. Every
  group (a <SettingsGroup>, see parts.tsx) sits on one page, and is known here by its title in
  lowercase with dashes ("Start-up" is "start-up"), which SettingsGroup puts on its section as
  `data-settings-group`. SettingsScreen.tsx lays the groups out on their pages; this list says which
  page each group is on, so a link can open Settings at a group without knowing the layout:
  `openSettings({ group: 'accounts' })` from the frame, `useOpenSettings()` in a Section, or
  <SettingsLink>. A group added to Settings goes in both places (settings-pages.test.tsx checks
  they agree).
*/

/** The shortcut scope while Settings is open, and the reveal channel that picks its page. */
export const SETTINGS = 'settings';

export interface SettingsPage {
  id: string;
  /** Its name in the sidebar, the palette and the sheet's title: "Accounts". */
  label: string;
  /** The sheet's subtitle: what is on the page. */
  summary: string;
  /** Its groups, top to bottom, by id. */
  groups: readonly string[];
}

/** The pages, in sidebar order. */
export const SETTINGS_PAGES = [
  {
    id: 'general',
    label: 'General',
    summary: 'Theme, signal colour and start-up',
    // The Design gallery's group shows only in development builds.
    groups: ['appearance', 'start-up', 'design'],
  },
  { id: 'accounts', label: 'Accounts', summary: 'The Sources Commander syncs', groups: ['accounts'] },
  { id: 'ares', label: 'Ares', summary: 'His model, jobs, cap and usage', groups: ['ares', 'usage'] },
  { id: 'autonomy', label: 'Autonomy', summary: 'What Ares may do on his own', groups: ['autonomy'] },
  {
    id: 'projects',
    label: 'Projects',
    summary: 'Projects, and the Rules that file into them',
    groups: ['projects', 'rules'],
  },
  { id: 'people', label: 'People', summary: 'Everyone Commander knows', groups: ['people'] },
  { id: 'notes', label: 'Notes', summary: 'The daily template', groups: ['notes'] },
  { id: 'email', label: 'Email', summary: 'Reading, writing and Buckets', groups: ['email', 'buckets'] },
  { id: 'calendar', label: 'Calendar', summary: 'Meetings, focus time and scheduling', groups: ['calendar'] },
  { id: 'github', label: 'GitHub', summary: 'What Commander watches', groups: ['github'] },
  { id: 'teams', label: 'Teams', summary: 'Chats left out, and channel posts', groups: ['teams'] },
  {
    id: 'data',
    label: 'Data',
    summary: 'Snapshots, Export everything and the Markdown copy',
    groups: ['snapshots', 'export', 'markdown-copy'],
  },
  { id: 'security', label: 'Security', summary: 'Sign-ins and API keys', groups: ['security'] },
  {
    id: 'diagnostics',
    label: 'Diagnostics',
    summary: 'How Commander is doing, its syncs, and the log to export',
    groups: ['diagnostics'],
  },
] as const satisfies readonly SettingsPage[];

export type SettingsPageId = (typeof SETTINGS_PAGES)[number]['id'];
export type SettingsGroupId = (typeof SETTINGS_PAGES)[number]['groups'][number];

/** Where in Settings to open: a page at its top, or the page a group is on, at the group. */
export type SettingsPlace = { page: SettingsPageId } | { group: SettingsGroupId };

/** A group's id, from its title: "Start-up" is "start-up", "Markdown copy" is "markdown-copy". */
export function settingsGroupId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** The page a group is on. */
export function pageOf(group: SettingsGroupId): SettingsPageId {
  const page = SETTINGS_PAGES.find((each) => (each.groups as readonly string[]).includes(group));
  if (!page) throw new Error(`No Settings page has the group "${group}"`);
  return page.id;
}

/**
 * Asks Settings to show a page, or a group on its page (frame/reveal.ts: the page as the Item, the
 * group as where in it). Settings stays mounted, so it hears this at once; the frame opens it.
 */
export function showInSettings(place: SettingsPlace): void {
  if ('group' in place) requestReveal(SETTINGS, pageOf(place.group), place.group);
  else requestReveal(SETTINGS, place.page);
}
