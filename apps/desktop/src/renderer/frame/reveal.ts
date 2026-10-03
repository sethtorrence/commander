import { useEffect, useRef } from 'react';

/*
  Asking another Section to show one of its Items: a Todo's made-from Link opens Notes at its Block,
  and a Block's Todo opens the Todos Section at that Todo. The asking Section opens the other one
  (useOpenSection) and asks here; the Section named takes the request, now if it is listening, or as
  soon as it starts to (every Section stays mounted, so it is usually listening already).
*/

type Listener = (itemId: string) => void;

const listeners = new Map<string, Set<Listener>>();
// A request no Section has taken yet, by Section id.
const waiting = new Map<string, string>();

/** Asks a Section (by its id) to show an Item. */
export function requestReveal(sectionId: string, itemId: string): void {
  const heard = listeners.get(sectionId);
  if (!heard?.size) {
    waiting.set(sectionId, itemId);
    return;
  }
  for (const listener of heard) listener(itemId);
}

/** Hears the requests to show an Item in a Section, the waiting one first. Returns the stop function. */
export function onReveal(sectionId: string, listener: Listener): () => void {
  const heard = listeners.get(sectionId) ?? new Set();
  listeners.set(sectionId, heard);
  heard.add(listener);
  const pending = waiting.get(sectionId);
  if (pending !== undefined) {
    waiting.delete(sectionId);
    listener(pending);
  }
  return () => {
    heard.delete(listener);
  };
}

/** `onReveal` for a component: `show` is called with the id of each Item the Section is asked to show. */
export function useReveal(sectionId: string, show: Listener): void {
  const latest = useRef(show);
  latest.current = show;
  useEffect(() => onReveal(sectionId, (itemId) => latest.current(itemId)), [sectionId]);
}
