// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectFilterBar } from './project-filter-bar';

afterEach(cleanup);

const projects = [
  { id: 'p-lt', code: 'LT', name: 'Longtail', accent: 'blue', count: 3 },
  { id: 'p-tl', code: 'TL', name: 'Titanlink', accent: 'teal', count: 0 },
];

function renderBar(props: Partial<Parameters<typeof ProjectFilterBar>[0]> = {}) {
  const onSelect = vi.fn();
  render(
    <ProjectFilterBar
      projects={projects}
      everything={5}
      unfiled={2}
      selected="everything"
      onSelect={onSelect}
      {...props}
    />,
  );
  return { onSelect, bar: screen.getByRole('group', { name: 'Project filter' }) };
}

describe('ProjectFilterBar', () => {
  it('offers Everything, each Project with its Badge, and Unfiled, each with its count', () => {
    const { bar } = renderBar();

    expect(
      within(bar)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['0Everything05', '1LTLongtail03', '2TLTitanlink00', 'U—Unfiled02']);
    expect(within(bar).getByRole('img', { name: 'Longtail' })).toHaveProperty('textContent', 'LT');
    expect(within(bar).getByRole('img', { name: 'Unfiled' })).toHaveProperty('textContent', '—');
  });

  it('marks the selected filter', () => {
    const { bar } = renderBar({ selected: 'p-lt' });

    const pressed = within(bar)
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-pressed') === 'true');
    expect(pressed.map((button) => button.textContent)).toEqual(['1LTLongtail03']);
  });

  it('selects a filter when clicked', () => {
    const { bar, onSelect } = renderBar();

    fireEvent.click(within(bar).getByRole('button', { name: /Titanlink/ }));
    fireEvent.click(within(bar).getByRole('button', { name: /Unfiled/ }));
    fireEvent.click(within(bar).getByRole('button', { name: /Everything/ }));

    expect(onSelect.mock.calls).toEqual([['p-tl'], ['unfiled'], ['everything']]);
  });

  it('shows which number picks which filter while p waits for its second key', () => {
    const { bar } = renderBar({ armed: true });

    expect(bar.dataset.armed).toBe('true');
    expect(bar.textContent).toContain('All');
  });
});
