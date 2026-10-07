// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AresButton } from './ares-button';

afterEach(cleanup);

describe('AresButton', () => {
  it('on a row: the AI mark alone, named by what it asks', () => {
    const onClick = vi.fn();
    render(<AresButton aria-label="Ask Ares about Q4 offsite dates" onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Ask Ares about Q4 offsite dates' });
    expect(button.textContent).toBe('');
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('on a pane: the mark and its words, “Ask Ares” unless told otherwise', () => {
    render(
      <>
        <AresButton variant="pane" />
        <AresButton variant="pane" label="Draft" />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Ask Ares' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Draft' })).toBeTruthy();
  });

  it('shows the lamp instead of the mark while Ares works on it', () => {
    render(<AresButton variant="pane" label="Drafting…" busy disabled />);
    const button = screen.getByRole('button', { name: 'Drafting…' });
    expect(button.getAttribute('data-busy')).toBe('true');
    expect(button.querySelector('[data-slot="led"]')).not.toBeNull();
    expect(button.querySelector('svg')).toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
