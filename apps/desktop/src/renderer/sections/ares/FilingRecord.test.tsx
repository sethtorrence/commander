// @vitest-environment jsdom
import type { FilingRecord as Record } from '@commander/domain';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AutonomyClient } from './activity';
import { FilingRecord } from './FilingRecord';

// Ares's filing record on his activity page, in all and per Source (#108), so his filing on Teams
// can be read on its own.

afterEach(cleanup);

const record: Record = {
  filed: 3,
  suggested: 6,
  confirmed: 2,
  corrected: 3,
  bySource: [
    { source: 'teams', filed: 1, suggested: 4, confirmed: 1, corrected: 3 },
    { source: 'linear', filed: 2, suggested: 2, confirmed: 1, corrected: 0 },
  ],
};

const client = (async () => record) as unknown as AutonomyClient;

describe('Ares’s filing record', () => {
  it('shows his record in all, then one row per Source with its own share kept', async () => {
    render(<FilingRecord client={client} shown />);

    const all = screen.getByTestId('filing-record');
    expect((await within(all).findByTestId('filing-record-filed')).textContent).toBe('3');
    expect(screen.getByText('40% kept')).toBeTruthy();

    const bySource = await screen.findByRole('table', { name: 'Filing by Source' });
    const teams = within(bySource).getByRole('row', { name: /Teams/ });
    expect(
      within(teams)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['1', '4', '1', '3', '25%']);
    const linear = within(bySource).getByRole('row', { name: /Linear/ });
    expect(
      within(linear)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['2', '2', '1', '0', '100%']);
  });
});
