// @vitest-environment jsdom
import type { CoreMessage } from '@commander/domain';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AresStatus } from './Header';
import { useAresStatus } from './use-ares-status';

afterEach(cleanup);

describe('the Ares status module', () => {
  it('says when Ares is idle', () => {
    render(<AresStatus />);
    expect(screen.getByTestId('ares-state').textContent).toBe('Idle');
    expect(screen.getByTestId('ares-status').dataset.working).toBeUndefined();
  });

  it('says when Ares is working, and on what', () => {
    render(<AresStatus working={{ working: true, running: ['Suggest Todos'] }} />);
    expect(screen.getByTestId('ares-state').textContent).toBe('Working');
    expect(screen.getByTestId('ares-status').textContent).toContain('Ares is working on Suggest Todos');
    expect(screen.getByTestId('ares-status').dataset.working).toBe('true');
  });
});

describe('useAresStatus', () => {
  it('asks the Core where Ares stands, then follows its word as jobs start and finish', async () => {
    let listener: (message: CoreMessage) => void = () => {};
    const client = async () => ({ jobs: [], status: { working: true, running: ['Suggest Todos'] } });
    const onCoreMessage = (next: (message: CoreMessage) => void) => {
      listener = next;
      return () => {};
    };
    const { result } = renderHook(() => useAresStatus(client, onCoreMessage));
    await waitFor(() => expect(result.current).toEqual({ working: true, running: ['Suggest Todos'] }));
    act(() => listener({ type: 'ares-status', working: false, running: [] }));
    expect(result.current).toEqual({ working: false, running: [] });
    act(() => listener({ type: 'heartbeat', beats: 1, at: 1 }));
    expect(result.current).toEqual({ working: false, running: [] });
  });
});
