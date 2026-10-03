import { useEffect, useState } from 'react';

// Settings → Start at login. Off by default. Minimal until the app frame (#40) gives it a home in Settings.
export function StartAtLogin() {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    window.commander.startAtLogin().then(setEnabled);
  }, []);

  return (
    <p>
      <label>
        <input
          type="checkbox"
          data-testid="start-at-login"
          checked={enabled ?? false}
          disabled={enabled === null}
          onChange={(event) => window.commander.setStartAtLogin(event.target.checked).then(setEnabled)}
        />{' '}
        Start at login (Commander waits in the tray)
      </label>
    </p>
  );
}
