import { useMemo } from 'react';
import { itemChangesFromCore } from '../../item-store/changes';
import type { SectionDefinition } from '../section';
import { EmailSheet } from './EmailSheet';
import { emailAccountsIn, emailIn } from './email';

// The Email Section: one inbox across every email Account (Gmail so far), as threads, with the
// Account switcher narrowing to one; a thread opens with its messages as plain text. It reaches the
// app only through email.ts, via the window's bridge.
function EmailSection() {
  const client = useMemo(() => emailIn(window.commander.itemStore), []);
  const accounts = useMemo(() => emailAccountsIn(window.commander), []);
  return <EmailSheet client={client} accounts={accounts} changes={itemChangesFromCore} />;
}

export const email: SectionDefinition = {
  id: 'email',
  label: 'Email',
  code: 'EML',
  Component: EmailSection,
};
