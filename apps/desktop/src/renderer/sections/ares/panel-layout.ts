import { useCallback, useEffect, useState } from 'react';

/*
  The Ares panel's layout (#235), remembered in localStorage across Sections and restarts, like the
  Project filter: whether it is open, how wide it is, and the Conversation it shows. Its width is
  the User's, within limits: never narrower than a thread can be read in, never so wide that the
  Section beside it has no room (on a narrow window the Section gives way first).
*/

export const PANEL_STORAGE_KEY = 'commander.ares-panel';

export const PANEL_WIDTH = 420;
export const MIN_PANEL_WIDTH = 320;
export const MAX_PANEL_WIDTH = 760;
// What the Section beside it always keeps.
export const MIN_SECTION_WIDTH = 560;

export type PanelLayout = { open: boolean; width: number; conversationId: string | null };

const DEFAULT: PanelLayout = { open: false, width: PANEL_WIDTH, conversationId: null };

/** The panel's width within its limits, on a window `viewWidth` wide. */
export function panelWidth(width: number, viewWidth: number): number {
  const widest = Math.min(MAX_PANEL_WIDTH, viewWidth - MIN_SECTION_WIDTH);
  return Math.round(Math.max(MIN_PANEL_WIDTH, Math.min(width, widest)));
}

export function loadPanelLayout(storage: Storage): PanelLayout {
  try {
    const saved: unknown = JSON.parse(storage.getItem(PANEL_STORAGE_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return DEFAULT;
    const { open, width, conversationId } = saved as Record<string, unknown>;
    return {
      open: open === true,
      width: typeof width === 'number' && Number.isFinite(width) ? width : PANEL_WIDTH,
      conversationId: typeof conversationId === 'string' && conversationId ? conversationId : null,
    };
  } catch {
    return DEFAULT;
  }
}

export function savePanelLayout(storage: Storage, layout: PanelLayout): void {
  try {
    storage.setItem(PANEL_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage unavailable: the layout still holds for this session.
  }
}

export type PanelLayoutState = PanelLayout & {
  setOpen(open: boolean): void;
  toggle(): void;
  setWidth(width: number): void;
  setConversation(conversationId: string | null): void;
};

/** The panel's layout as the frame holds it: read once, saved as it changes. */
export function usePanelLayout(storage: Storage = window.localStorage): PanelLayoutState {
  const [layout, setLayout] = useState(() => loadPanelLayout(storage));
  useEffect(() => savePanelLayout(storage, layout), [storage, layout]);
  const setOpen = useCallback(
    (open: boolean) => setLayout((now) => (now.open === open ? now : { ...now, open })),
    [],
  );
  const toggle = useCallback(() => setLayout((now) => ({ ...now, open: !now.open })), []);
  const setWidth = useCallback(
    (width: number) => setLayout((now) => (now.width === width ? now : { ...now, width })),
    [],
  );
  const setConversation = useCallback(
    (conversationId: string | null) =>
      setLayout((now) => (now.conversationId === conversationId ? now : { ...now, conversationId })),
    [],
  );
  return { ...layout, setOpen, toggle, setWidth, setConversation };
}
