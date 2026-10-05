import { WhatAresKnows } from '../../memory/WhatAresKnows';
import { SettingsGroup } from '../../settings/parts';
import { EmptySheet, type SectionDefinition, SectionSheet, useSection } from '../section';
import { ActivityPage } from './ActivityPage';
import { FilingRecord } from './FilingRecord';

// Reloads Ares's activity whenever the Core says he did or suggested something.
const onAresActivity = (listener: () => void) =>
  window.commander.onCoreMessage((message) => {
    if (message.type === 'ares-activity') listener();
  });

// What Ares knows may have changed: he did or suggested something (an answer to him is an example),
// or a job finished (Learn facts).
const onMemoryChange = (listener: () => void) =>
  window.commander.onCoreMessage((message) => {
    if (message.type === 'ares-activity' || message.type === 'items-changed') listener();
    if (message.type === 'ares-status' && !message.working) listener();
  });

// The Ares Section: Ares's activity page (opened from the header's Ares status module, too), What
// Ares knows (#74) and, with their own ticket, Conversations.
function AresSection() {
  const { active } = useSection();
  return (
    <SectionSheet
      span="full"
      subtitle={
        <>
          <b>Everything Ares did or suggested</b> · what he knows, and Conversations with him
        </>
      }
    >
      <ActivityPage client={window.commander.autonomy} shown={active} onAresActivity={onAresActivity} />
      <FilingRecord client={window.commander.autonomy} shown={active} onAresActivity={onAresActivity} />
      <WhatAresKnows no="A3" client={window.commander.itemStore} shown={active} onRefresh={onMemoryChange} />
      <SettingsGroup no="A4" title="Conversations">
        <EmptySheet>No Conversations yet.</EmptySheet>
      </SettingsGroup>
    </SectionSheet>
  );
}

export const ares: SectionDefinition = {
  id: 'ares',
  label: 'Ares',
  code: 'ARS',
  Component: AresSection,
};
