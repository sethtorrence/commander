// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Badge } from './badge';
import { SuggestedFiling } from './suggested-filing';

afterEach(cleanup);

describe('the dashed Badge', () => {
  it('shows Ares’s suggested Project, dashed, read out as a suggestion', () => {
    render(<Badge kind="suggested" code="TL" accent="blue" project="Titanlink" />);
    const badge = screen.getByRole('img', { name: 'Ares suggests Titanlink' });
    expect(badge.textContent).toBe('TL');
    expect(badge.className).toContain('border-dashed');
    expect(badge.getAttribute('data-suggested')).toBe('true');
  });

  it('comes with Confirm and Change', () => {
    const onConfirm = vi.fn();
    const onChange = vi.fn();
    render(
      <SuggestedFiling
        code="TL"
        accent="blue"
        project="Titanlink"
        onConfirm={onConfirm}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('img', { name: 'Ares suggests Titanlink' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Titanlink' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Change the Project' }));
    expect(onChange).toHaveBeenCalledOnce();
  });
});
