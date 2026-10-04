import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type DisplayServer,
  ipc,
  WINDOW_CONTROLS,
  type WindowControl,
  type WindowFrame,
} from '@commander/domain';
import type { BrowserWindowConstructorOptions } from 'electron';
import { z } from 'zod';
import { type ConfigProvider, configProvider } from './summon';

// Commander's window has no Electron or system frame: the Industrial header is the title bar and
// draws minimise, maximise and close itself (renderer/frame/WindowControls.tsx), asking for them
// through the preload bridge. On macOS the traffic lights stay, inset into the header.

export function windowFrameOptions(
  platform: NodeJS.Platform,
): Pick<BrowserWindowConstructorOptions, 'frame' | 'titleBarStyle' | 'trafficLightPosition'> {
  // Centred in the 64px header, clear of the ruler corner (frame.css makes room for them).
  if (platform === 'darwin') return { titleBarStyle: 'hidden', trafficLightPosition: { x: 32, y: 25 } };
  return { frame: false };
}

export type FrameEnvironment = {
  platform: NodeJS.Platform;
  displayServer: DisplayServer;
  /** Running under Hyprland (HYPRLAND_INSTANCE_SIGNATURE), natively or through XWayland. */
  hyprland: boolean;
};

export type FrameBehaviour = Pick<WindowFrame, 'controls' | 'minimise'> & {
  // Who maximises: the window itself (Electron), or Hyprland, which tells every window it is
  // maximised (tiled and floating alike), so Electron can't know or change the real state.
  maximise: 'window' | 'compositor';
};

export function frameBehaviour({ platform, displayServer, hyprland }: FrameEnvironment): FrameBehaviour {
  return {
    controls: platform === 'darwin' ? 'native' : 'header',
    // Wayland has no minimised state: Hyprland ignores the request and the window stays on screen.
    minimise: hyprland || displayServer === 'wayland' ? 'hide' : 'minimise',
    maximise: hyprland ? 'compositor' : 'window',
  };
}

// Hyprland's maximised state (fullscreen mode 1: the window fills its workspace, the bar stays)
// is what the User's own "maximise" bind toggles; it works tiled and floating.
export function hyprlandMaximiseArgs(provider: ConfigProvider, pid: number): string[] {
  return provider === 'lua'
    ? [
        'dispatch',
        `hl.dsp.window.fullscreen({ mode = "maximized", action = "toggle", window = "pid:${pid}" })`,
      ]
    : ['--batch', `dispatch focuswindow pid:${pid} ; dispatch fullscreen 1`];
}

// `hyprctl clients -j` reports each window's fullscreen state: 0 none, 1 maximised, 2 fullscreen
// (older versions: true or false).
const hyprlandClients = z.array(
  z.object({ pid: z.number(), fullscreen: z.union([z.number(), z.boolean()]) }).loose(),
);

export function maximisedFromHyprland(clientsJson: string, pid: number): boolean | null {
  let json: unknown;
  try {
    json = JSON.parse(clientsJson);
  } catch {
    return null;
  }
  const clients = hyprlandClients.safeParse(json);
  const ours = clients.success ? clients.data.find((client) => client.pid === pid) : undefined;
  if (!ours) return null;
  return typeof ours.fullscreen === 'boolean' ? ours.fullscreen : ours.fullscreen !== 0;
}

export type Compositor = {
  /** Null when the compositor can't say. */
  isMaximised(): Promise<boolean | null>;
  toggleMaximised(): Promise<void>;
};

export function hyprlandCompositor(pid: number): Compositor {
  const hyprctl = (args: string[]) => promisify(execFile)('hyprctl', args).then(({ stdout }) => stdout);
  return {
    isMaximised: () =>
      hyprctl(['clients', '-j']).then(
        (clients) => maximisedFromHyprland(clients, pid),
        () => null,
      ),
    async toggleMaximised() {
      const status = await hyprctl(['-j', 'status']).catch(() => '');
      await hyprctl(hyprlandMaximiseArgs(configProvider(status), pid));
    },
  };
}

type WindowEvent = 'maximize' | 'unmaximize' | 'resize' | 'show';
export type ControlledWindow = {
  isDestroyed(): boolean;
  isMaximized(): boolean;
  minimize(): void;
  hide(): void;
  close(): void;
  maximize(): void;
  unmaximize(): void;
  on(event: WindowEvent, listener: () => void): unknown;
  webContents: { send(channel: string, frame: WindowFrame): void };
};

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown;
type IpcHandlers = { handle(channel: string, handler: Handler): void };

const isWindowControl = (value: unknown): value is WindowControl =>
  (WINDOW_CONTROLS as readonly unknown[]).includes(value);

// Hyprland settles a maximise or a retile in a few frames; ask once it has.
const SETTLE_MS = 120;

/** Answers the header's window controls, and pushes the frame whenever it is maximised or restored. */
export function installWindowControls({
  window,
  ipc: channels,
  behaviour,
  compositor,
}: {
  window: ControlledWindow;
  ipc: IpcHandlers;
  behaviour: FrameBehaviour;
  /** Asked for the maximised state, and to change it, when behaviour.maximise is 'compositor'. */
  compositor: Compositor;
}): void {
  const { maximise, ...shape } = behaviour;
  const byCompositor = maximise === 'compositor';
  let last: boolean | null = null;

  const read = async (): Promise<WindowFrame> => ({
    ...shape,
    maximised: byCompositor ? ((await compositor.isMaximised()) ?? false) : window.isMaximized(),
  });
  const push = (frame: WindowFrame) => {
    if (frame.maximised === last || window.isDestroyed()) return;
    last = frame.maximised;
    window.webContents.send(ipc.windowFrameChanged, frame);
  };
  const refresh = async () => push(await read());

  if (byCompositor) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), SETTLE_MS);
    };
    window.on('resize', settle);
    window.on('show', settle);
  } else {
    window.on('maximize', () => void refresh());
    window.on('unmaximize', () => void refresh());
  }

  const fromOwnWindow = (event: { sender: unknown }) => {
    if (event.sender !== window.webContents) throw new Error('Only Commander’s window has window controls');
  };

  channels.handle(ipc.windowFrame, async (event) => {
    fromOwnWindow(event);
    const frame = await read();
    last = frame.maximised;
    return frame;
  });
  channels.handle(ipc.windowControl, async (event, control) => {
    fromOwnWindow(event);
    if (!isWindowControl(control)) throw new Error(`Not a window control: ${JSON.stringify(control)}`);
    if (window.isDestroyed()) return;
    if (control === 'close') return window.close();
    if (control === 'minimise') return behaviour.minimise === 'hide' ? window.hide() : window.minimize();
    if (!byCompositor) return window.isMaximized() ? window.unmaximize() : window.maximize();
    await compositor.toggleMaximised();
    await refresh();
  });
}
