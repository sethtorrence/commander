import { SettingsGroup } from '../../settings/parts';
import { EmptySheet, type SectionDefinition, SectionSheet, useSection } from '../section';
import { ActivityPage } from './ActivityPage';

// Reloads Ares's activity whenever the Core says he did or suggested something.
const onAresActivity = (listener: () => void) =>
  window.commander.onCoreMessage((message) => {
    if (message.type === 'ares-activity') listener();
  });

// The Ares Section: Ares's activity page (opened from the header's Ares status module, too) and,
// with their own ticket, Conversations.
function AresSection() {
  const { active } = useSection();
  return (
    <SectionSheet
      span="full"
      subtitle={
        <>
          <b>Everything Ares did or suggested</b> · and Conversations with him
        </>
      }
    >
      <ActivityPage client={window.commander.autonomy} shown={active} onAresActivity={onAresActivity} />
      <SettingsGroup no="A2" title="Conversations">
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
