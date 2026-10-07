import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// With its extension, like every import here: the installer (scripts/install.ts) runs this module in
// Node directly, which doesn't guess extensions.
import { APP_ENTRY } from './summon.ts';

// "Start at login" on Linux: an XDG autostart entry in ~/.config/autostart. The entry existing
// *is* the setting, so it is off until the User turns it on. Commander starts hidden in the tray.

export function autostartPath(env: Partial<Record<'XDG_CONFIG_HOME', string>>, home: string): string {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'autostart', APP_ENTRY);
}

export function launchAtLoginCommand(app: {
  execPath: string;
  appPath: string;
  isPackaged: boolean;
}): string[] {
  return app.isPackaged ? [app.execPath, '--hidden'] : [app.execPath, app.appPath, '--hidden'];
}

// Desktop entry spec, "The Exec key": reserved characters need the argument double-quoted, with
// " ` $ \ backslash-escaped inside; then the value as a whole escapes its backslashes again,
// and a literal % is written %%.
const reserved = /[\s"'\\><~|&;$*?#()`]/;

function quoteArgument(arg: string): string {
  const quoted = reserved.test(arg) ? `"${arg.replace(/["`$\\]/g, '\\$&')}"` : arg;
  return quoted.replaceAll('\\', '\\\\').replaceAll('%', '%%');
}

// A desktop entry's Exec value for the command (the installer's launcher uses it too).
export const execValue = (command: string[]) => command.map(quoteArgument).join(' ');

export function autostartEntry(command: string[]): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Commander',
    'Comment=Start Commander in the tray at login',
    `Exec=${execValue(command)}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export function isAutostartEnabled(path: string): boolean {
  return existsSync(path);
}

export function setAutostart(path: string, enabled: boolean, command: string[]): void {
  if (!enabled) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, autostartEntry(command));
}
