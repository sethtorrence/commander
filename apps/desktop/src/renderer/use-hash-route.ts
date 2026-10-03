import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

/** The current location hash (e.g. `#/design`), updating when it changes. */
export function useHashRoute(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash);
}
