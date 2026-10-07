// Ares's own settings (#197), as a change to one of them reads and writes them: the Autonomy grid
// (through the gate's own setLevel, so the hard limits hold), each tier's thinking level and each job's
// own, the monthly cap and search by meaning (Settings → Ares, the models' settings), and the meeting
// heads-up (Settings → Calendar). Each is written where Settings writes it, through the same checks,
// so Settings shows the new value when it next opens and the Core acts on it from the next call (or,
// for search by meaning, starts or frees its model at once).
import {
  type AutonomyLevel,
  type AutonomyTarget,
  type SettingChange,
  type SettingValue,
  searchByMeaningOn,
} from '@commander/domain';
import type { ItemStore } from '../item-store';
import type { Meaning } from '../meaning';

// Which setting a change is to, without its values.
type WithoutValues<T> = T extends unknown ? Omit<T, 'from' | 'to'> : never;
export type SettingKey = WithoutValues<SettingChange>;

export type OwnSettings = {
  /** The value a setting has now. */
  value(key: SettingKey): SettingValue;
  /** Sets a setting to the change's `to`, as Settings would (its checks and the hard limits hold). */
  write(change: SettingChange): void;
};

export function createOwnSettings({
  itemStore,
  setLevel,
  meaning,
}: {
  itemStore: Pick<ItemStore, 'autonomy' | 'models' | 'calendarSettings'>;
  // The gate's: one cell of the Autonomy grid, refused above a hard limit.
  setLevel: (target: AutonomyTarget, level: AutonomyLevel | null) => unknown;
  // Search by meaning, which switches its model on or off as well as saving the setting.
  meaning?: () => Pick<Meaning, 'setOn'> | undefined;
}): OwnSettings {
  const models = () => itemStore.models.settings();

  return {
    value(key) {
      switch (key.setting) {
        case 'autonomy': {
          const settings = itemStore.autonomy.settings();
          const { target } = key;
          if (target.scope === 'everywhere') return settings.everywhere[target.actionKind];
          if (target.scope === 'section')
            return settings.sections[target.section]?.[target.actionKind] ?? null;
          return settings.actions[target.action] ?? null;
        }
        case 'tier-thinking':
          return models().tiers[key.tier].reasoningEffort;
        case 'job-thinking':
          return models().jobOverrides[key.job]?.reasoningEffort ?? null;
        case 'monthly-cap':
          return models().monthlyCapUsd;
        case 'meeting-heads-up':
          return itemStore.calendarSettings.read().headsUp;
        case 'search-by-meaning':
          return searchByMeaningOn(models());
      }
    },

    write(change) {
      switch (change.setting) {
        case 'autonomy':
          setLevel(change.target, change.to);
          return;
        case 'tier-thinking': {
          const settings = models();
          const tier = { ...settings.tiers[change.tier], reasoningEffort: change.to };
          itemStore.models.saveSettings({ ...settings, tiers: { ...settings.tiers, [change.tier]: tier } });
          return;
        }
        case 'job-thinking': {
          const settings = models();
          const { [change.job]: _was, ...others } = settings.jobOverrides;
          const jobOverrides =
            change.to === null ? others : { ...others, [change.job]: { reasoningEffort: change.to } };
          itemStore.models.saveSettings({ ...settings, jobOverrides });
          return;
        }
        case 'monthly-cap':
          itemStore.models.saveSettings({ ...models(), monthlyCapUsd: change.to });
          return;
        case 'meeting-heads-up':
          itemStore.calendarSettings.save({ headsUp: change.to });
          return;
        case 'search-by-meaning': {
          const switcher = meaning?.();
          if (switcher) switcher.setOn(change.to);
          else itemStore.models.saveSettings({ ...models(), searchByMeaning: change.to });
          return;
        }
      }
    },
  };
}
