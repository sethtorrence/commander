import type { DisplayServer } from '@commander/domain';
import { z } from 'zod';

// Electron can't tell us which display platform Chromium picked, so on Hyprland we ask the
// compositor: `hyprctl clients -j` lists every window with its pid and whether it is XWayland.
const hyprlandClients = z.array(z.object({ pid: z.number(), xwayland: z.boolean() }).loose());

export function displayServerFromHyprland(clientsJson: string, pid: number): DisplayServer | null {
  let json: unknown;
  try {
    json = JSON.parse(clientsJson);
  } catch {
    return null;
  }
  const clients = hyprlandClients.safeParse(json);
  const ours = clients.success ? clients.data.find((client) => client.pid === pid) : undefined;
  if (!ours) return null;
  return ours.xwayland ? 'xwayland' : 'wayland';
}

export type LaunchEnvironment = {
  platform: NodeJS.Platform;
  ozonePlatform: string;
  ozoneHint: string;
  waylandDisplay: string | undefined;
};

// Elsewhere we can only guess from the launch switches and the session.
export function inferDisplayServer(env: LaunchEnvironment): DisplayServer {
  if (env.platform !== 'linux') return 'other';
  const waylandSession = !!env.waylandDisplay;
  const native =
    env.ozonePlatform === 'wayland' ||
    (env.ozonePlatform === '' && ['auto', 'wayland'].includes(env.ozoneHint) && waylandSession);
  if (native) return 'wayland';
  return waylandSession ? 'xwayland' : 'x11';
}
