// @vitest-environment jsdom
import type { WindowControl, WindowFrame } from '@commander/domain';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWindowFrame, type WindowBridge, WindowControls } from './WindowControls';

afterEach(cleanup);

const hyprland: WindowFrame = { controls: 'header', minimise: 'hide', maximised: false };
const windows: WindowFrame = { controls: 'header', minimise: 'minimise', maximised: false };

describe('WindowControls', () => {
  it('draws minimise, maximise and close, each with a clear label, and asks for each', () => {
    const onControl = vi.fn<(control: WindowControl) => void>();
    render(<WindowControls frame={windows} onControl={onControl} />);
    const group = screen.getByRole('group', { name: 'Window' });
    expect(group).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Minimise' }));
    fireEvent.click(screen.getByRole('button', { name: 'Maximise' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onControl.mock.calls.map(([control]) => control)).toEqual([
      'minimise',
      'toggle-maximise',
      'close',
    ]);
  });

  it('offers Restore while the window is maximised', () => {
    render(<WindowControls frame={{ ...windows, maximised: true }} onControl={() => {}} />);
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Maximise' })).toBeNull();
  });

  it('says where Commander goes: close keeps it running in the tray, and so does minimise on Wayland', () => {
    render(<WindowControls frame={hyprland} onControl={() => {}} />);
    expect(screen.getByRole('button', { name: 'Close' }).title).toMatch(/keeps running in the tray/);
    expect(screen.getByRole('button', { name: 'Minimise' }).title).toMatch(/tray/);
  });

  it('a real minimise says nothing of the tray', () => {
    render(<WindowControls frame={windows} onControl={() => {}} />);
    expect(screen.getByRole('button', { name: 'Minimise' }).title).not.toMatch(/tray/);
  });

  it('draws nothing where the platform draws the controls (macOS traffic lights), or before the frame is known', () => {
    const { container, rerender } = render(
      <WindowControls frame={{ ...windows, controls: 'native' }} onControl={() => {}} />,
    );
    expect(container.innerHTML).toBe('');
    rerender(<WindowControls frame={null} onControl={() => {}} />);
    expect(container.innerHTML).toBe('');
  });
});

function fakeBridge(initial: WindowFrame) {
  let listener: ((frame: WindowFrame) => void) | null = null;
  const bridge: WindowBridge = {
    windowFrame: async () => initial,
    windowControl: vi.fn(async () => {}),
    onWindowFrame: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
  return { bridge, push: (frame: WindowFrame) => listener?.(frame), listening: () => listener !== null };
}

describe('useWindowFrame', () => {
  it('reads the frame, then follows what main pushes, until unmounted', async () => {
    const { bridge, push, listening } = fakeBridge(windows);
    const { result, unmount } = renderHook(() => useWindowFrame(bridge));
    await waitFor(() => expect(result.current).toEqual(windows));

    act(() => push({ ...windows, maximised: true }));
    expect(result.current?.maximised).toBe(true);

    unmount();
    expect(listening()).toBe(false);
  });

  it('keeps a pushed state that arrives before the first read answers', async () => {
    const { bridge, push } = fakeBridge(windows);
    let answer: (frame: WindowFrame) => void = () => {};
    bridge.windowFrame = () => new Promise((resolve) => (answer = resolve));
    const { result } = renderHook(() => useWindowFrame(bridge));
    act(() => push({ ...windows, maximised: true }));
    await act(async () => answer(windows));
    expect(result.current?.maximised).toBe(true);
  });
});
