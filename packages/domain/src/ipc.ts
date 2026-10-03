// The contract between the main process and the window, carried over the preload bridge.
export const ipc = {
  coreMessage: 'core-message',
  diagnostics: 'diagnostics',
} as const;

// How the window reaches the screen. 'xwayland' means a Wayland session fell back to X11.
export type DisplayServer = 'wayland' | 'xwayland' | 'x11' | 'other';

export type Diagnostics = {
  displayServer: DisplayServer;
  // 'compositor' when the compositor confirmed it, 'inferred' when guessed from launch switches.
  displaySource: 'compositor' | 'inferred';
  passwordStore: string;
  electron: string;
};
