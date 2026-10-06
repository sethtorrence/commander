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

  it('shows the quiet count, whether you’re here, and asks for an update only when pressed', () => {
    let asked = 0;
    const { rerender } = render(<AresStatus queued={3} presence="here" onAsk={() => asked++} />);
    expect(screen.getByTestId('ares-queued').textContent).toBe('03');
    expect(screen.getByTestId('ares-status').textContent).toContain('Ares has 3 things for you');
    expect(screen.getByTestId('ares-presence').textContent).toBe('You’re here');
    expect(asked).toBe(0);
    screen.getByRole('button', { name: 'Ask for an update' }).click();
    expect(asked).toBe(1);

    rerender(<AresStatus queued={3} presence="away" awaySince={new Date(2026, 9, 3, 18, 40)} />);
    expect(screen.getByTestId('ares-presence').textContent).toBe('Away · since 18:40');
    expect(screen.getByTestId('ares-status').textContent).toContain('Ares is holding 3 things for you');
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

  it('asks again when a new Core is running, whose jobs ended with the old one', async () => {
    let listener: (message: CoreMessage) => void = () => {};
    let working = true;
    const client = async () => ({
      jobs: [],
      status: working ? { working: true, running: ['Suggest Todos'] } : { working: false, running: [] },
    });
    const onCoreMessage = (next: (message: CoreMessage) => void) => {
      listener = next;
      return () => {};
    };
    const { result } = renderHook(() => useAresStatus(client, onCoreMessage));
    await waitFor(() => expect(result.current.working).toBe(true));
    working = false;
    act(() => listener({ type: 'core-restarted', at: 1 }));
    await waitFor(() => expect(result.current).toEqual({ working: false, running: [] }));
  });
});
