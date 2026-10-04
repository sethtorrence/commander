import type { SearchQuery } from '@commander/domain';
import type { AccountSummary } from '@commander/domain/ipc';
import { toast, useAppearance } from '@commander/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { requestReveal } from '../frame/reveal';
import { useNow } from '../frame/use-now';
import { PEOPLE_SETTINGS } from '../people/PeopleSettings';
import { useProjects } from '../projects/context';
import { inFilter } from '../projects/filter';
import { SECTIONS } from '../sections';
import { linearAccountsIn } from '../sections/linear/linear-issues';
import { dayKey } from '../sections/notes/days';
import { sectionFor } from '../sections/todos/links';
import { useShortcuts } from '../shortcuts/react';
import { useCommandRegistry, useCommands } from './commands';
import { Palette } from './Palette';
import { scopeFor } from './query';
import type { PaletteAction } from './rows';

/*
  The palette in the frame: `Ctrl+K` (everywhere, even while typing) opens it on everything, `/`
  (when not typing) opens it on the open Section and the Project filter. It registers the frame's
  own commands, and carries out what the User picks: opening a Section, a Project page, today's
  Daily Note, an Item where it lives (frame/reveal.ts), a command, or Linear's own search in
  the browser.
*/

export interface PaletteHostProps {
  /** The open Section's id (or "settings", or the Project page's scope). */
  current: string;
  onOpenSection(sectionId: string): void;
  onOpenSettings(): void;
  onToggleShortcuts(): void;
}

const report = (error: unknown) => toast(error instanceof Error ? error.message : String(error));

function useAccounts(): AccountSummary[] {
  const client = useMemo(() => linearAccountsIn(window.commander), []);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  useEffect(() => {
    let current = true;
    client.list().then((next) => current && setAccounts(next), report);
    const stop = client.onChange((next) => current && setAccounts(next));
    return () => {
      current = false;
      stop();
    };
  }, [client]);
  return accounts;
}

export function PaletteHost({ current, onOpenSection, onOpenSettings, onToggleShortcuts }: PaletteHostProps) {
  const [shown, setShown] = useState<{ open: boolean; initial: string; mode: 'jump' | 'find' }>({
    open: false,
    initial: '',
    mode: 'jump',
  });
  const { projects, filter, setFilter, openPage } = useProjects();
  const { toggleTheme } = useAppearance();
  const commands = useCommandRegistry();
  const accounts = useAccounts();
  const now = useNow(60_000);
  const today = dayKey(now);
  const connected = accounts.filter((account) => account.status === 'connected');

  const search = useCallback((query: SearchQuery) => window.commander.itemStore({ op: 'search', query }), []);
  const setOpen = useCallback((open: boolean) => setShown((now) => ({ ...now, open })), []);

  useShortcuts([
    {
      keys: 'Ctrl+k',
      label: 'Search, jump and commands',
      group: 'General',
      inFields: true,
      inDialogs: true,
      run: () =>
        setShown((now) => (now.open ? { ...now, open: false } : { open: true, initial: '', mode: 'jump' })),
    },
    {
      keys: '/',
      label: 'Search this Section',
      group: 'General',
      run: () => setShown({ open: true, initial: scopeFor(current, filter, projects), mode: 'find' }),
    },
  ]);

  useCommands([
    { label: 'Open Settings', keys: ',', group: 'General', run: onOpenSettings },
    { label: 'Keyboard shortcuts', keys: '?', group: 'General', inDialogs: true, run: onToggleShortcuts },
    { label: 'Switch theme', run: toggleTheme },
    {
      label: 'Sync Linear now',
      when: () => connected.length > 0,
      run: () => {
        const client = linearAccountsIn(window.commander);
        for (const account of connected) client.syncNow(account.id).catch(report);
        toast(`Syncing ${connected.map((account) => account.name).join(', ')}`);
      },
    },
  ]);

  const onAction = (action: PaletteAction) => {
    switch (action.type) {
      case 'section':
        return onOpenSection(action.sectionId);
      case 'today':
        // Today's Daily Note is on top of Notes, which opens scrolled to the top.
        return onOpenSection('notes');
      case 'project':
        return openPage?.(action.projectId);
      case 'person':
        // Settings → People at the Person, until the People view (#122) gives them a page.
        onOpenSettings();
        return requestReveal(PEOPLE_SETTINGS, action.personId);
      case 'command':
        return action.command.run();
      case 'browser':
        window.open(action.url, '_blank', 'noopener');
        return;
      case 'item': {
        const { item } = action.hit;
        const sectionId = sectionFor(item.kind);
        if (!sectionId) return toast('That kind of Item has no Section to open it in yet');
        // The Item would be hidden by the Project filter: show everything instead.
        if (!inFilter(filter, item)) setFilter('everything');
        onOpenSection(sectionId);
        return requestReveal(sectionId, item.id);
      }
    }
  };

  return (
    <Palette
      open={shown.open}
      onOpenChange={setOpen}
      initial={shown.initial}
      mode={shown.mode}
      search={search}
      sections={SECTIONS}
      current={current}
      projects={projects}
      commands={commands.available}
      accounts={accounts}
      now={now}
      today={today}
      onAction={onAction}
    />
  );
}
