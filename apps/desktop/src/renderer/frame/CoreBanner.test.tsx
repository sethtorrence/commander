// @vitest-environment jsdom
import { CORE_DOWN, type CoreStatus } from '@commander/domain';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameControlsProvider } from '../sections/section';
import { CoreBanner } from './CoreBanner';

afterEach(cleanup);

const status = (state: CoreStatus['state'], restarts = 0): CoreStatus => ({
  state,
  restartAt: null,
  restarts,
  lastStop: state === 'running' && restarts === 0 ? null : { at: 1, reason: 'exited', code: 1 },
});

// The bridge's Core status, pushed by hand.
function bridge(initial: CoreStatus) {
  let push: (next: CoreStatus) => void = () => {};
  return {
    coreStatus: vi.fn(async () => initial),
    onCoreStatus: (listener: (next: CoreStatus) => void) => {
      push = listener;
      return () => {};
    },
    restartCore: vi.fn(async () => {}),
    push: (next: CoreStatus) => act(() => push(next)),
  };
}

describe('the Core banner', () => {
  it('shows nothing while the Core runs, and says so quietly while a new one starts', async () => {
    const core = bridge(status('running'));
    render(<CoreBanner bridge={core} />);
    await act(async () => {});
    expect(screen.queryByTestId('core-banner')).toBeNull();

    core.push(status('restarting'));
    expect(screen.getByTestId('core-banner').textContent).toBe(CORE_DOWN.restarting);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();

    core.push(status('running', 1));
    expect(screen.queryByTestId('core-banner')).toBeNull();
  });

  it('once Commander stopped trying, offers Try again and Diagnostics', async () => {
    const core = bridge(status('stopped', 3));
    const openSettings = vi.fn();
    render(
      <FrameControlsProvider value={{ openSection: () => {}, setTabCount: () => {}, openSettings }}>
        <CoreBanner bridge={core} />
      </FrameControlsProvider>,
    );
    await act(async () => {});
    expect(screen.getByTestId('core-banner').textContent).toContain(CORE_DOWN.stopped);

    act(() => screen.getByRole('button', { name: 'Diagnostics' }).click());
    expect(openSettings).toHaveBeenCalledWith({ page: 'diagnostics' });
    act(() => screen.getByRole('button', { name: 'Try again' }).click());
    expect(core.restartCore).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Try again' })).toHaveProperty('disabled', true);
  });
});
