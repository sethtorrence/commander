import type { SearchQuery } from '@commander/domain';
import type { AccountSummary } from '@commander/domain/ipc';
import { toast, useAppearance } from '@commander/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { requestReveal } from '../frame/reveal';
import { useNow } from '../frame/use-now';
import { WHAT_ARES_KNOWS } from '../memory/WhatAresKnows';
import { usePeople } from '../people/context';
import { PEOPLE_SETTINGS } from '../people/PeopleSettings';
import { useProjects } from '../projects/context';
import { inFilter } from '../projects/filter';
import { SECTIONS } from '../sections';
import { type EmailAccountSummary, emailAccountsIn } from '../sections/email/email';
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

// The email Accounts (Gmail or Outlook mail on), for Search in Gmail and Search in Outlook.
function useEmailAccounts(): EmailAccountSummary[] {
  const client = useMemo(() => emailAccountsIn(window.commander), []);
  const [accounts, setAccounts] = useState<EmailAccountSummary[]>([]);
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
  const { openPerson } = usePeople();
  const { toggleTheme } = useAppearance();
  const commands = useCommandRegistry();
  const accounts = useAccounts();
  const emailAccounts = useEmailAccounts();
  const gmailAccounts = useMemo(
    () => emailAccounts.flatMap((each) => (each.source === 'google' ? [{ email: each.email }] : [])),
    [emailAccounts],
  );
  const outlookAccounts = useMemo(
    () =>
      emailAccounts.flatMap((each) =>
        each.source === 'outlook'
          ? [{ address: each.userPrincipalName, personal: each.personal === true }]
          : [],
      ),
    [emailAccounts],
  );
  const now = useNow(60_000);
  const today = dayKey(now);
  const connected = accounts.filter((account) => account.status === 'connected');

  const search = useCallback((query: SearchQuery) => window.commander.itemStore({ op: 'search', query }), []);
  // Search by meaning (#73): the Core embeds the query with the local model; null until it's ready.
  const searchByMeaning = useCallback(
    (query: SearchQuery) =>
      window.commander
        .models({ op: 'search-meaning', query })
        .then((response) => (response.ok ? response.result : null)),
    [],
  );
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
        // Their page (#122); Settings → People at the Person where there are no pages.
        if (openPerson) return openPerson(action.personId);
        onOpenSettings();
        return requestReveal(PEOPLE_SETTINGS, action.personId);
      case 'memory':
        // What Ares knows, in the Ares Section, at the memory.
        onOpenSection('ares');
        return requestReveal(WHAT_ARES_KNOWS, action.memoryId);
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
      searchByMeaning={searchByMeaning}
      sections={SECTIONS}
      current={current}
      projects={projects}
      commands={commands.available}
      accounts={accounts}
      gmailAccounts={gmailAccounts}
      outlookAccounts={outlookAccounts}
      now={now}
      today={today}
      onAction={onAction}
    />
  );
}
