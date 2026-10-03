import {
  Button,
  ButtonGroup,
  SectionHeader,
  Sheet,
  SignalColourPicker,
  THEMES,
  useAppearance,
} from '@commander/ui';
import { partNumber } from '../frame/calendar';
import { useNow } from '../frame/use-now';
import { AccountsPanel } from './AccountsPanel';
import { Diagnostics } from './Diagnostics';
import { SettingRow, SettingsGroup } from './parts';
import { SecurityPanel } from './SecurityPanel';
import { StartAtLogin } from './StartAtLogin';

const THEME_NAMES = { dark: 'Dark', light: 'Light' } as const;

function ThemeChoice() {
  const { theme, setTheme } = useAppearance();
  return (
    <ButtonGroup role="radiogroup" aria-label="Theme">
      {THEMES.map((option) => (
        <Button
          key={option}
          role="radio"
          aria-checked={theme === option}
          variant={theme === option ? 'primary' : 'default'}
          onClick={() => setTheme(option)}
        >
          {THEME_NAMES[option]}
        </Button>
      ))}
    </ButtonGroup>
  );
}

/** Settings, opened from the header (or `,`) as a temporary tab. */
export function SettingsScreen() {
  const today = useNow(60_000);
  return (
    <Sheet
      data-testid="settings"
      className="col-span-8 mr-4 ml-3.5 min-h-[calc(100vh-var(--body))] border-t-0 pb-27.5"
    >
      <SectionHeader
        eyebrow="Settings"
        partNumber={partNumber('SET', today)}
        title="Settings"
        subtitle={
          <>
            <b>Appearance, start-up and security</b> · kept on this machine
          </>
        }
      />
      <SettingsGroup no="01" title="Appearance" note="Theme · signal colour">
        <SettingRow
          label="Theme"
          description="Graphite (dark) or concrete (light). Also on the tabs’ right edge."
        >
          <ThemeChoice />
        </SettingRow>
        <SettingRow
          label="Signal colour"
          description="The colour of live things and of Ares. Adjusted per theme so it stays legible."
        >
          <SignalColourPicker className="max-w-[820px]" />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup no="02" title="Start-up" note="Tray">
        <StartAtLogin />
      </SettingsGroup>
      <AccountsPanel no="03" />
      <SecurityPanel no="04" />
      <Diagnostics no="05" />
      <SettingsGroup no="06" title="Design" note="Industrial design system">
        <SettingRow label="Design gallery" description="Every token and component, dark and light.">
          <Button asChild>
            <a href="#/design" className="no-underline">
              Open the design gallery →
            </a>
          </Button>
        </SettingRow>
      </SettingsGroup>
    </Sheet>
  );
}
