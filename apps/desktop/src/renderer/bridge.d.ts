import type { CommanderBridge } from '../preload';

declare global {
  interface Window {
    // The preload bridge: the window's only way to reach the app (see src/preload/index.ts).
    commander: CommanderBridge;
  }
}
