import { useEffect, useRef } from 'react';

/*
  Asking another Section to show one of its Items: a Todo's made-from Link opens Notes at its Block,
  and a Block's Todo opens the Todos Section at that Todo. The asking Section opens the other one
  (useOpenSection) and asks here; the Section named takes the request, now if it is listening, or as
  soon as it starts to (every Section stays mounted, so it is usually listening already).
*/

// `focus`: where in the Item to show, when the asker knows (a Chat's message, by its id).
type Listener = (itemId: string, focus?: string) => void;

const listeners = new Map<string, Set<Listener>>();
// A request no Section has taken yet, by Section id.
const waiting = new Map<string, { itemId: string; focus?: string }>();

/** Asks a Section (by its id) to show an Item, at `focus` within it if given (a Chat's message). */
export function requestReveal(sectionId: string, itemId: string, focus?: string): void {
  const heard = listeners.get(sectionId);
  if (!heard?.size) {
    waiting.set(sectionId, { itemId, focus });
    return;
  }
  for (const listener of heard) listener(itemId, focus);
}

/** Hears the requests to show an Item in a Section, the waiting one first. Returns the stop function. */
export function onReveal(sectionId: string, listener: Listener): () => void {
  const heard = listeners.get(sectionId) ?? new Set();
  listeners.set(sectionId, heard);
  heard.add(listener);
  const pending = waiting.get(sectionId);
  if (pending !== undefined) {
    waiting.delete(sectionId);
    listener(pending.itemId, pending.focus);
  }
  return () => {
    heard.delete(listener);
  };
}

/**
 * `onReveal` for a component: `show` is called with the id of each Item the Section is asked to
 * show, and where in it, when asked.
 */
export function useReveal(sectionId: string, show: Listener): void {
  const latest = useRef(show);
  latest.current = show;
  useEffect(() => onReveal(sectionId, (itemId, focus) => latest.current(itemId, focus)), [sectionId]);
}
