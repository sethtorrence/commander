import { describe, expect, it } from 'vitest';
import { displayServerFromHyprland, inferDisplayServer } from './display-server';

describe('displayServerFromHyprland', () => {
  const clients = JSON.stringify([
    { class: 'firefox', pid: 100, xwayland: false },
    { class: 'commander', pid: 200, xwayland: false },
    { class: 'steam', pid: 300, xwayland: true },
  ]);

  it('reports a native Wayland window when Hyprland lists ours as not XWayland', () => {
    expect(displayServerFromHyprland(clients, 200)).toBe('wayland');
  });

  it('reports an XWayland fallback when Hyprland lists ours as XWayland', () => {
    expect(displayServerFromHyprland(clients, 300)).toBe('xwayland');
  });

  it.each([
    ['our window is not listed yet', clients, 999],
    ['the output is not JSON', 'Hyprland not running', 200],
    ['the output is not a client list', '{"ok":true}', 200],
  ])('knows nothing when %s', (_case, output, pid) => {
    expect(displayServerFromHyprland(output, pid)).toBeNull();
  });
});

describe('inferDisplayServer', () => {
  const linux = {
    platform: 'linux',
    ozonePlatform: '',
    ozoneHint: 'auto',
    waylandDisplay: 'wayland-1',
  } as const;

  it('guesses native Wayland in a Wayland session with the auto hint', () => {
    expect(inferDisplayServer(linux)).toBe('wayland');
  });

  it('guesses XWayland when forced onto X11 inside a Wayland session', () => {
    expect(inferDisplayServer({ ...linux, ozonePlatform: 'x11' })).toBe('xwayland');
  });

  it('guesses X11 outside a Wayland session', () => {
    expect(inferDisplayServer({ ...linux, waylandDisplay: undefined })).toBe('x11');
  });

  it('has no display server to speak of off Linux', () => {
    expect(inferDisplayServer({ ...linux, platform: 'darwin' })).toBe('other');
  });
});
