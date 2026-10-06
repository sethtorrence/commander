import { useMemo } from 'react';
import { itemChangesFromCore } from '../../item-store/changes';
import type { SectionDefinition } from '../section';
import { composeIn } from './compose/compose';
import { EmailSheet } from './EmailSheet';
import { emailAccountsIn, emailIn } from './email';
import { emailReaderIn } from './reader';

// The Email Section: one inbox across every email Account (Gmail so far), as threads, with the
// Account switcher narrowing to one; a thread opens with each message's HTML in a sandboxed frame
// (or its text). It reaches the app only through email.ts and reader.ts, via the window's bridge.
function EmailSection() {
  const client = useMemo(() => emailIn(window.commander.itemStore), []);
  const accounts = useMemo(() => emailAccountsIn(window.commander), []);
  const reader = useMemo(() => emailReaderIn(window.commander), []);
  const compose = useMemo(() => composeIn(window.commander), []);
  return (
    <EmailSheet
      client={client}
      accounts={accounts}
      changes={itemChangesFromCore}
      reader={reader}
      compose={compose}
      onSaveBeforeQuit={window.commander.onSaveBeforeQuit}
      autonomy={window.commander.autonomy}
      onAresActivity={onAresActivity}
    />
  );
}

// Ares did or suggested something: his Skip the inbox suggestions are read again (#142).
const onAresActivity = (listener: () => void) =>
  window.commander.onCoreMessage((message) => {
    if (message.type === 'ares-activity') listener();
  });

export const email: SectionDefinition = {
  id: 'email',
  label: 'Email',
  code: 'EML',
  Component: EmailSection,
};
