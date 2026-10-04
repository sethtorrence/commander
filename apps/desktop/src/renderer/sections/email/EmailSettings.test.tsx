// @vitest-environment jsdom
import type { EmailImageAccount } from '@commander/domain';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailSettings } from './EmailSettings';
import { textOnlyReader } from './reader';

afterEach(cleanup);

function fakeReader(accounts: EmailImageAccount[]) {
  return {
    ...textOnlyReader,
    imageSettings: vi.fn(async () => accounts),
    setAskFirst: vi.fn(async () => {}),
    untrustSender: vi.fn(async () => {}),
  };
}

describe('Settings → Email', () => {
  it('offers Ask before showing images for Gmail Accounts, saying why, and lists trusted senders to remove', async () => {
    const reader = fakeReader([
      { account: 'google:1', name: 'alex@gmail.test', source: 'gmail', askFirst: false, trustedSenders: [] },
      {
        account: 'outlook:1',
        name: 'sam@contoso.test',
        source: 'outlook',
        askFirst: false,
        trustedSenders: ['news@shop.test'],
      },
    ]);
    render(<EmailSettings no="16" reader={reader} onAccountsChanged={() => () => {}} />);
    const ask = await screen.findByRole('switch', { name: 'Ask before showing images for alex@gmail.test' });
    expect(ask.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/Commander can’t, so it loads them directly/)).toBeTruthy();
    expect(screen.queryByRole('switch', { name: /sam@contoso.test/ })).toBeNull();
    fireEvent.click(ask);
    await waitFor(() => expect(reader.setAskFirst).toHaveBeenCalledWith('google:1', true));

    const outlook = screen.getByRole('region', { name: 'sam@contoso.test' });
    expect(within(outlook).getByTestId('trusted-sender').textContent).toContain('news@shop.test');
    fireEvent.click(
      within(outlook).getByRole('button', { name: 'Stop always showing images from news@shop.test' }),
    );
    await waitFor(() => expect(reader.untrustSender).toHaveBeenCalledWith('outlook:1', 'news@shop.test'));
  });

  it('shows nothing without an email Account', async () => {
    const reader = fakeReader([]);
    const { container } = render(
      <EmailSettings no="16" reader={reader} onAccountsChanged={() => () => {}} />,
    );
    await waitFor(() => expect(reader.imageSettings).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
