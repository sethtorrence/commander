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

  describe('with Project pages', () => {
    it('gives each Project an open control, and opens its page on a double-click too', () => {
      const onOpenPage = vi.fn();
      const { bar } = renderBar({ onOpenPage });

      fireEvent.click(within(bar).getByRole('button', { name: 'Open the Titanlink page' }));
      fireEvent.doubleClick(within(bar).getByTitle('Only Longtail'));

      expect(onOpenPage.mock.calls).toEqual([['p-tl'], ['p-lt']]);
      expect(within(bar).queryByRole('button', { name: /Unfiled page/ })).toBeNull();
    });

    it('offers the selected Project’s page at the end of the bar', () => {
      const onOpenPage = vi.fn();
      const { bar } = renderBar({ onOpenPage, selected: 'p-tl' });

      fireEvent.click(within(bar).getByRole('button', { name: 'Titanlink page ↗' }));

      expect(onOpenPage).toHaveBeenCalledWith('p-tl');
    });

    it('shows O for the page while p waits', () => {
      const { bar } = renderBar({ onOpenPage: vi.fn(), armed: true });

      expect(bar.textContent).toContain('OPage');
    });

    it('on a Project page, marks its open control and offers the way back', () => {
      const onBack = vi.fn();
      const { bar } = renderBar({
        onOpenPage: vi.fn(),
        selected: 'p-lt',
        page: 'p-lt',
        back: { label: 'Todos', onClick: onBack },
      });

      expect(within(bar).getByRole('button', { name: 'Open the Longtail page' }).dataset.on).toBe('true');
      expect(within(bar).queryByRole('button', { name: 'Longtail page ↗' })).toBeNull();
      fireEvent.click(within(bar).getByRole('button', { name: 'TodosEsc' }));
      expect(onBack).toHaveBeenCalledOnce();
    });
  });
});
