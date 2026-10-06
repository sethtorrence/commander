import { MarkdownCopySetting } from '../sections/notes/MarkdownCopySetting';
import { SettingRow, SettingsGroup } from './parts';

/*
  Settings → Data (#199): what Commander keeps of the User's data besides the database itself. The
  daily snapshots (the Core's item-store/snapshots.ts) have nothing to change yet, so they are
  described; the Markdown copy of the Daily Notes moved here from Notes. Backups and wiping come to
  this page next.
*/

/** Snapshots: the database copies the Core makes each day. */
export function SnapshotSettings({ no }: { no: string }) {
  return (
    <SettingsGroup no={no} title="Snapshots" note="Daily · last 7 kept">
      <SettingRow
        label="Daily snapshots"
        description="A copy of the database, made each day Commander runs, in the snapshots folder beside it."
      >
        <p className="m-0 max-w-[560px] text-note leading-[19px] text-muted" data-testid="snapshots-setting">
          Commander makes one when it starts and checks again every hour, so a Commander left running still
          gets one a day. It keeps the last 7 and removes older ones.
        </p>
      </SettingRow>
    </SettingsGroup>
  );
}

/** The Markdown copy of the Daily Notes, for Obsidian, grep and backups. */
export function MarkdownCopySettings({ no }: { no: string }) {
  return (
    <SettingsGroup no={no} title="Markdown copy" note="Daily Notes · read-only">
      <MarkdownCopySetting />
    </SettingsGroup>
  );
}
