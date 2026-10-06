import { WhatAresKnows } from '../../memory/WhatAresKnows';
import { type SectionDefinition, SectionSheet, useSection } from '../section';
import { ActivityPage } from './ActivityPage';
import { Conversations } from './Conversations';
import { FilingRecord } from './FilingRecord';
import { WhatAresCanDo } from './WhatAresCanDo';

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

// Ares's answers stream in, and his turns change, as core messages.
const onCoreMessage = (listener: Parameters<typeof window.commander.onCoreMessage>[0]) =>
  window.commander.onCoreMessage(listener);

// The Ares Section: Ares's activity page (opened from the header's Ares status module, too), What
// Ares knows (#74), Conversations with him (#191) and What Ares can do (#192).
function AresSection() {
  const { active } = useSection();
  return (
    <SectionSheet
      span="full"
      subtitle={
        <>
          <b>Everything Ares did or suggested</b> · what he knows, Conversations with him, and what he can do
        </>
      }
    >
      <ActivityPage client={window.commander.autonomy} shown={active} onAresActivity={onAresActivity} />
      <FilingRecord client={window.commander.autonomy} shown={active} onAresActivity={onAresActivity} />
      <WhatAresKnows no="A3" client={window.commander.itemStore} shown={active} onRefresh={onMemoryChange} />
      <Conversations client={window.commander.conversations} shown={active} onCoreMessage={onCoreMessage} />
      <WhatAresCanDo client={window.commander.conversations} shown={active} />
    </SectionSheet>
  );
}

export const ares: SectionDefinition = {
  id: 'ares',
  label: 'Ares',
  code: 'ARS',
  Component: AresSection,
};
