import { EventEmitter } from 'node:events';
import { ipc, type WindowFrame } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Compositor,
  type ControlledWindow,
  frameBehaviour,
  hyprlandMaximiseArgs,
  installWindowControls,
  maximisedFromHyprland,
  windowFrameOptions,
} from './window-frame';

describe('windowFrameOptions', () => {
  it.each(['linux', 'win32'] as const)(
    'takes the frame away on %s: the header is the title bar',
    (platform) => {
      expect(windowFrameOptions(platform)).toEqual({ frame: false });
    },
  );

  it('keeps the traffic lights on macOS, inset into the header', () => {
    const options = windowFrameOptions('darwin');
    expect(options.titleBarStyle).toBe('hidden');
    expect(options.frame).toBeUndefined();
    expect(options.trafficLightPosition).toBeDefined();
  });
});

describe('frameBehaviour', () => {
  it('on Hyprland, minimise hides to the tray and maximise goes through the compositor', () => {
    expect(frameBehaviour({ platform: 'linux', displayServer: 'wayland', hyprland: true })).toEqual({
      controls: 'header',
      minimise: 'hide',
      maximise: 'compositor',
    });
  });

  it('on Hyprland through XWayland too: Hyprland has no minimised state either way', () => {
    expect(frameBehaviour({ platform: 'linux', displayServer: 'xwayland', hyprland: true })).toEqual({
      controls: 'header',
      minimise: 'hide',
      maximise: 'compositor',
    });
  });

  it('on another Wayland compositor, minimise hides (no minimised state) and the window maximises itself', () => {
    expect(frameBehaviour({ platform: 'linux', displayServer: 'wayland', hyprland: false })).toEqual({
      controls: 'header',
      minimise: 'hide',
      maximise: 'window',
    });
  });

  it.each([
    ['X11', 'linux', 'x11'],
    ['XWayland outside Hyprland', 'linux', 'xwayland'],
    ['Windows', 'win32', 'other'],
  ] as const)('on %s, minimise is a real minimise', (_case, platform, displayServer) => {
    expect(frameBehaviour({ platform, displayServer, hyprland: false })).toEqual({
      controls: 'header',
      minimise: 'minimise',
      maximise: 'window',
    });
  });

  it('on macOS the traffic lights are the controls', () => {
    expect(frameBehaviour({ platform: 'darwin', displayServer: 'other', hyprland: false })).toEqual({
      controls: 'native',
      minimise: 'minimise',
      maximise: 'window',
    });
  });
});

describe('hyprlandMaximiseArgs', () => {
  it('toggles our window (by pid) into Hyprland’s maximised state on a Lua config', () => {
    expect(hyprlandMaximiseArgs('lua', 4242)).toEqual([
      'dispatch',
      'hl.dsp.window.fullscreen({ mode = "maximized", action = "toggle", window = "pid:4242" })',
    ]);
  });

  it('focuses our window, then toggles maximised, on a text config', () => {
    expect(hyprlandMaximiseArgs('text', 4242)).toEqual([
      '--batch',
      'dispatch focuswindow pid:4242 ; dispatch fullscreen 1',
    ]);
  });
});

describe('maximisedFromHyprland', () => {
  const clients = (fullscreen: unknown) =>
    JSON.stringify([
      { class: 'firefox', pid: 100, fullscreen: 2 },
      { class: 'commander', pid: 200, fullscreen },
    ]);

  it('reads our window as maximised when Hyprland has it maximised (1) or fullscreen (2)', () => {
    expect(maximisedFromHyprland(clients(1), 200)).toBe(true);
    expect(maximisedFromHyprland(clients(2), 200)).toBe(true);
  });

  it('reads our window as not maximised when it is tiled or floating (0)', () => {
    expect(maximisedFromHyprland(clients(0), 200)).toBe(false);
  });

  it('understands older Hyprland versions, which report fullscreen as true or false', () => {
    expect(maximisedFromHyprland(clients(true), 200)).toBe(true);
    expect(maximisedFromHyprland(clients(false), 200)).toBe(false);
  });

  it.each([
    ['our window is not listed', clients(1), 999],
    ['the output is not JSON', 'Hyprland not running', 200],
  ])('knows nothing when %s', (_case, output, pid) => {
    expect(maximisedFromHyprland(output, pid)).toBeNull();
  });
});

// A BrowserWindow stand-in that records what it was asked to do.
class FakeWindow extends EventEmitter implements ControlledWindow {
  calls: string[] = [];
  maximised = false;
  destroyed = false;
  sent: WindowFrame[] = [];
  webContents = {
    send: (channel: string, frame: WindowFrame) => {
      if (channel === ipc.windowFrameChanged) this.sent.push(frame);
    },
  };
  isDestroyed = () => this.destroyed;
  isMaximized = () => this.maximised;
  minimize = () => this.calls.push('minimize');
  hide = () => this.calls.push('hide');
  close = () => this.calls.push('close');
  maximize = () => {
    this.calls.push('maximize');
    this.maximised = true;
    this.emit('maximize');
  };
  unmaximize = () => {
    this.calls.push('unmaximize');
    this.maximised = false;
    this.emit('unmaximize');
  };
}

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown;
function fakeIpc() {
  const handlers = new Map<string, Handler>();
  return {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    invoke: async (channel: string, sender: unknown, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`nothing handles ${channel}`);
      return handler({ sender }, ...args);
    },
  };
}

// Hyprland's maximised state, as `hyprctl clients -j` would report it.
function fakeCompositor(): Compositor & { maximised: boolean | null; toggles: number } {
  const compositor = {
    maximised: false as boolean | null,
    toggles: 0,
    isMaximised: async () => compositor.maximised,
    toggleMaximised: async () => {
      compositor.toggles += 1;
      compositor.maximised = !compositor.maximised;
    },
  };
  return compositor;
}

function setUp(behaviour = frameBehaviour({ platform: 'linux', displayServer: 'x11', hyprland: false })) {
  const window = new FakeWindow();
  const channels = fakeIpc();
  const compositor = fakeCompositor();
  installWindowControls({ window, ipc: channels, behaviour, compositor });
  const own = window.webContents;
  return {
    window,
    compositor,
    frame: () => channels.invoke(ipc.windowFrame, own) as Promise<WindowFrame>,
    control: (action: unknown, sender: unknown = own) => channels.invoke(ipc.windowControl, sender, action),
  };
}

const hyprland = frameBehaviour({ platform: 'linux', displayServer: 'wayland', hyprland: true });

describe('installWindowControls', () => {
  it('tells the window how its frame behaves here', async () => {
    const { frame } = setUp();
    expect(await frame()).toEqual({ controls: 'header', minimise: 'minimise', maximised: false });
    expect(await setUp(hyprland).frame()).toEqual({ controls: 'header', minimise: 'hide', maximised: false });
  });

  it('close closes the window, which hides it to the tray (keepInTray) and leaves the Core running', async () => {
    const { window, control } = setUp();
    await control('close');
    expect(window.calls).toEqual(['close']);
  });

  it('minimise minimises where the platform has a minimised state', async () => {
    const { window, control } = setUp();
    await control('minimise');
    expect(window.calls).toEqual(['minimize']);
  });

  it('minimise hides to the tray on Wayland, which has no minimised state', async () => {
    const { window, control } = setUp(hyprland);
    await control('minimise');
    expect(window.calls).toEqual(['hide']);
  });

  it('maximise toggles the window between maximised and restored, and pushes the new state', async () => {
    const { window, control } = setUp();
    await control('toggle-maximise');
    expect(window.calls).toEqual(['maximize']);
    expect(window.sent.at(-1)).toMatchObject({ maximised: true });

    await control('toggle-maximise');
    expect(window.calls).toEqual(['maximize', 'unmaximize']);
    expect(window.sent.at(-1)).toMatchObject({ maximised: false });
  });

  it('pushes the state when the window is maximised some other way (double-clicking the header)', async () => {
    const { window } = setUp();
    window.maximize();
    await vi.waitFor(() =>
      expect(window.sent).toEqual([{ controls: 'header', minimise: 'minimise', maximised: true }]),
    );
  });

  describe('on Hyprland', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('maximise toggles Hyprland’s maximised state and pushes what Hyprland reports', async () => {
      const { window, compositor, control, frame } = setUp(hyprland);
      await control('toggle-maximise');
      expect(compositor.toggles).toBe(1);
      expect(window.calls).toEqual([]);
      expect(window.sent.at(-1)).toMatchObject({ maximised: true });
      expect(await frame()).toMatchObject({ maximised: true });

      await control('toggle-maximise');
      expect(window.sent.at(-1)).toMatchObject({ maximised: false });
    });

    it('ignores what Electron says (Hyprland tells every window it is maximised) and asks Hyprland', async () => {
      const { window, compositor, frame } = setUp(hyprland);
      window.maximised = true;
      expect(await frame()).toMatchObject({ maximised: false });
      compositor.maximised = true;
      expect(await frame()).toMatchObject({ maximised: true });
    });

    it('asks Hyprland again once the window settles after a resize, and pushes only a change', async () => {
      const { window, compositor } = setUp(hyprland);
      compositor.maximised = true; // e.g. maximised with the User's own Hyprland bind
      window.emit('resize');
      window.emit('resize');
      await vi.runAllTimersAsync();
      expect(window.sent).toEqual([{ controls: 'header', minimise: 'hide', maximised: true }]);

      window.emit('resize');
      await vi.runAllTimersAsync();
      expect(window.sent).toHaveLength(1);
    });

    it('treats an unknown Hyprland state as not maximised', async () => {
      const { compositor, frame } = setUp(hyprland);
      compositor.maximised = null;
      expect(await frame()).toMatchObject({ maximised: false });
    });
  });

  it('refuses requests from anything but Commander’s own window', async () => {
    const { window, control } = setUp();
    await expect(control('close', { stranger: true })).rejects.toThrow(/Commander’s window/);
    expect(window.calls).toEqual([]);
  });

  it.each([['maximise'], ['quit'], [undefined], [{ action: 'close' }]])(
    'refuses an unknown control: %j',
    async (action) => {
      const { window, control } = setUp();
      await expect(control(action)).rejects.toThrow(/window control/);
      expect(window.calls).toEqual([]);
    },
  );

  it('does nothing once the window is destroyed', async () => {
    const { window, control } = setUp();
    window.destroyed = true;
    await control('close');
    expect(window.calls).toEqual([]);
  });
});
