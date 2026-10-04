// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WarningMark } from './warning-mark';

afterEach(cleanup);

const MESSAGE = 'This issue contains instructions aimed at Ares. He ignored them.';

describe('WarningMark', () => {
  it('on a row: a short mark that reads out, and shows on hover, the whole warning', () => {
    render(<WarningMark message={MESSAGE} />);
    const mark = screen.getByTestId('injection-warning');
    expect(mark.textContent).toBe('Aimed at Ares');
    expect(mark.getAttribute('title')).toBe(MESSAGE);
    expect(screen.getByRole('note', { name: MESSAGE })).toBe(mark);
  });

  it('on a detail pane: the whole warning, in words', () => {
    render(<WarningMark variant="pane" message={MESSAGE} />);
    expect(screen.getByRole('note').textContent).toContain(MESSAGE);
  });
});
