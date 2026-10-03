import { EmptySheet, type SectionDefinition, SectionSheet } from '../section';

// The Email Section: an empty sheet until its own ticket fills it in.
function EmailSection() {
  return (
    <SectionSheet span="full" subtitle="Every email Account, sorted into Buckets">
      <EmptySheet>No email Accounts connected yet.</EmptySheet>
    </SectionSheet>
  );
}

export const email: SectionDefinition = {
  id: 'email',
  label: 'Email',
  code: 'EML',
  Component: EmailSection,
};
