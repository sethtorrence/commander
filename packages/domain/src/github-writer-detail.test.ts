import { describe, expect, it } from 'vitest';
import { areaOf, changeOutline } from './github-writer-detail';

// The change outline the summary's writer reads instead of the diff (#119): files changed grouped by
// top-level area, with additions and deletions per area.

describe('areaOf', () => {
  it('takes a monorepo package as its area', () => {
    expect(areaOf('apps/core/src/sync/engine.ts')).toBe('apps/core');
    expect(areaOf('packages/ui/src/button.tsx')).toBe('packages/ui');
    expect(areaOf('services/billing/main.go')).toBe('services/billing');
  });

  it('takes the top folder otherwise, and the root for files at the top', () => {
    expect(areaOf('src/index.ts')).toBe('src');
    expect(areaOf('docs/adr/0001.md')).toBe('docs');
    expect(areaOf('apps/README.md')).toBe('apps');
    expect(areaOf('package.json')).toBe('(root)');
  });
});

describe('changeOutline', () => {
  it('adds up each area’s files, additions and deletions, biggest change first', () => {
    const outline = changeOutline(
      [
        { path: 'apps/core/src/a.ts', additions: 10, deletions: 2 },
        { path: 'packages/ui/src/b.tsx', additions: 40, deletions: 30 },
        { path: 'apps/core/src/c.ts', additions: 5, deletions: 0 },
        { path: 'pnpm-lock.yaml', additions: 1, deletions: 1 },
      ],
      120,
    );
    expect(outline).toEqual({
      areas: [
        { area: 'packages/ui', files: 1, additions: 40, deletions: 30 },
        { area: 'apps/core', files: 2, additions: 15, deletions: 2 },
        { area: '(root)', files: 1, additions: 1, deletions: 1 },
      ],
      files: 4,
      totalFiles: 120,
    });
  });
});
