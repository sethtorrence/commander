import { useMemo } from 'react';
import type { SectionDefinition } from '../section';
import { CalendarSheet } from './CalendarSheet';
import { calendarAccountsIn, calendarEventsIn } from './calendar-events';
import { calendarSettingsIn } from './calendar-settings';
import { EventPrep } from './EventPrep';
import { invitationsIn } from './invitations';

// Ares's focus block suggestions are read again whenever the Core says he did or suggested something.
const onAresActivity = (listener: () => void) =>
  window.commander.onCoreMessage((message) => {
    if (message.type === 'ares-activity') listener();
  });

// The Calendar Section: the events of every calendar switched on in every connected Google and
// Outlook Account, as one Agenda, opened into a detail pane and filed into Projects. Making and
// changing events is the provider's: Edit and New event hand over to Google Calendar or Outlook on
// the web in the browser. It reaches the app only
// through calendar-events.ts, via the window's bridge.
function CalendarSection() {
  const events = useMemo(() => calendarEventsIn(window.commander.itemStore), []);
  const accounts = useMemo(() => calendarAccountsIn(window.commander), []);
  const settings = useMemo(() => calendarSettingsIn(window.commander.itemStore), []);
  const invitations = useMemo(() => invitationsIn(window.commander), []);
  return (
    <CalendarSheet
      events={events}
      accounts={accounts}
      settings={settings}
      Prep={EventPrep}
      invitations={invitations}
      autonomy={window.commander.autonomy}
      onAresActivity={onAresActivity}
    />
  );
}

export const calendar: SectionDefinition = {
  id: 'calendar',
  label: 'Calendar',
  code: 'CAL',
  Component: CalendarSection,
};
