import { Switch } from '@commander/ui';
import { useEffect, useState } from 'react';
import { SettingRow } from './parts';

// Settings → Start at login. Off by default; when on, Commander starts hidden in the tray.
export function StartAtLogin() {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    window.commander.startAtLogin().then(setEnabled);
  }, []);

  return (
    <SettingRow
      label="Start at login"
      description="Commander starts with your session and waits in the tray until you summon it."
    >
      <div className="flex items-center gap-3 font-mono text-label-lg leading-none font-semibold uppercase tracking-label text-ink">
        <Switch
          data-testid="start-at-login"
          aria-label="Start at login"
          checked={enabled ?? false}
          disabled={enabled === null}
          onCheckedChange={(next) => window.commander.setStartAtLogin(next).then(setEnabled)}
        />
        <span aria-hidden="true">{enabled ? 'On' : 'Off'}</span>
      </div>
    </SettingRow>
  );
}
