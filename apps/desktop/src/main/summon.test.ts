import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  configProvider,
  hyprlandFocusArgs,
  installSummon,
  type SummonableWindow,
  summonWindow,
} from './summon';

function fakeWindow(state: { minimized?: boolean; destroyed?: boolean } = {}) {
  const calls: string[] = [];
  const window: SummonableWindow = {
    isDestroyed: () => state.destroyed ?? false,
    isMinimized: () => state.minimized ?? false,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };
  return { window, calls };
}

describe('configProvider', () => {
  it('recognises a Lua Hyprland config from `hyprctl -j status`', () => {
    expect(configProvider('{\n    "configProvider": "lua",\n    "backend": "drm"\n}')).toBe('lua');
  });

  it.each([
    ['a text config', '{"configProvider": "hyprlang"}'],
    ['an older Hyprland without the status request', 'unknown request'],
    ['no output at all', ''],
  ])('assumes the text config for %s', (_case, output) => {
    expect(configProvider(output)).toBe('text');
  });
});

describe('hyprlandFocusArgs', () => {
  it('uses the hl.dsp.focus dispatcher on a Lua config', () => {
    expect(hyprlandFocusArgs('lua')).toEqual([
      'dispatch',
      'hl.dsp.focus({ window = "class:^(commander)$" })',
    ]);
  });

  it('uses focuswindow on a text config', () => {
    expect(hyprlandFocusArgs('text')).toEqual(['dispatch', 'focuswindow', 'class:^(commander)$']);
  });
});

describe('summonWindow', () => {
  it('shows and focuses a window hidden in the tray', () => {
    const { window, calls } = fakeWindow();
    summonWindow(window);
    expect(calls).toEqual(['show', 'focus']);
  });

  it('restores a minimised window first', () => {
    const { window, calls } = fakeWindow({ minimized: true });
    summonWindow(window);
    expect(calls).toEqual(['restore', 'show', 'focus']);
  });

  it('does nothing once the window is gone', () => {
    const { window, calls } = fakeWindow({ destroyed: true });
    summonWindow(window);
    summonWindow(null);
    expect(calls).toEqual([]);
  });
});

describe('installSummon', () => {
  function setup() {
    const app = new EventEmitter();
    const signals = new EventEmitter();
    const { window, calls } = fakeWindow();
    const focusThroughCompositor = vi.fn();
    installSummon({ app, signals, getWindow: () => window, focusThroughCompositor });
    return { app, signals, calls, focusThroughCompositor };
  }

  it('shows the window on SIGUSR1 from commander-show, which then focuses it through Hyprland', () => {
    const { signals, calls, focusThroughCompositor } = setup();
    signals.emit('SIGUSR1');
    expect(calls).toEqual(['show', 'focus']);
    expect(focusThroughCompositor).not.toHaveBeenCalled();
  });

  it('shows and focuses the running window when Commander is launched again', () => {
    const { app, calls, focusThroughCompositor } = setup();
    app.emit('second-instance');
    expect(calls).toEqual(['show', 'focus']);
    // Wayland doesn't let an app raise its own window, so ask the compositor.
    expect(focusThroughCompositor).toHaveBeenCalledOnce();
  });
});
