import { execFile } from 'node:child_process';

// Summoning Commander from anywhere. Electron's globalShortcut reports "registered" on Hyprland
// but never fires, and Wayland doesn't let an app raise its own window, so a Hyprland bind runs
// `commander-show` (apps/desktop/bin/commander-show): it sends SIGUSR1 to the running app (found
// through the pid file), the app shows its window, and the helper focuses it through Hyprland.
// A second launch of Commander lands here too, through the single-instance lock.

// The window's class (the Wayland app_id), set through app.setDesktopName in index.ts. End-to-end
// tests give their Commanders a class of their own (COMMANDER_WINDOW_CLASS, "commander-e2e"), so a
// Hyprland rule can keep their windows on a workspace away from the User's.
export const WINDOW_CLASS = process.env.COMMANDER_WINDOW_CLASS || 'commander';
export const DESKTOP_ENTRY = `${WINDOW_CLASS}.desktop`;
// Commander's own launcher entry (its autostart file), which stays "commander.desktop" even in tests.
export const APP_ENTRY = 'commander.desktop';

export type ConfigProvider = 'lua' | 'text';

// `hyprctl -j status` reports `"configProvider": "lua"` on a Lua config. Older Hyprland versions
// don't know the request, and those only have the text config.
export function configProvider(statusOutput: string): ConfigProvider {
  return /"configProvider"\s*:\s*"lua"/.test(statusOutput) ? 'lua' : 'text';
}

// Keep in step with bin/commander-show.
export function hyprlandFocusArgs(provider: ConfigProvider): string[] {
  const window = `class:^(${WINDOW_CLASS})$`;
  return provider === 'lua'
    ? ['dispatch', `hl.dsp.focus({ window = "${window}" })`]
    : ['dispatch', 'focuswindow', window];
}

export function focusThroughHyprland(): void {
  // Test Commanders never ask Hyprland for focus: it would switch the User to the test's workspace.
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE || process.env.COMMANDER_TEST_NO_FOCUS === '1') return;
  execFile('hyprctl', ['-j', 'status'], (_error, status) => {
    execFile('hyprctl', hyprlandFocusArgs(configProvider(String(status ?? ''))), () => {});
  });
}

export type SummonableWindow = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
};

export function summonWindow(window: SummonableWindow | null): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

type Emitter = { on(event: string, listener: () => void): unknown };

export function installSummon(options: {
  app: Emitter;
  signals: Emitter;
  getWindow: () => SummonableWindow | null;
  focusThroughCompositor: () => void;
}): void {
  const { app, signals, getWindow, focusThroughCompositor } = options;
  // commander-show does the compositor focus itself, right after the signal.
  signals.on('SIGUSR1', () => summonWindow(getWindow()));
  app.on('second-instance', () => {
    summonWindow(getWindow());
    focusThroughCompositor();
  });
}
