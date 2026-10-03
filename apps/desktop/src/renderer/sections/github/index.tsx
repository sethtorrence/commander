import { EmptySheet, type SectionDefinition, SectionSheet } from '../section';

// The GitHub Section: an empty sheet until its own ticket fills it in.
function GitHubSection() {
  return (
    <SectionSheet span="full" subtitle="Pull requests, reviews and the repos you watch">
      <EmptySheet>No GitHub Account connected yet.</EmptySheet>
    </SectionSheet>
  );
}

export const github: SectionDefinition = {
  id: 'github',
  label: 'GitHub',
  code: 'GH',
  Component: GitHubSection,
};
