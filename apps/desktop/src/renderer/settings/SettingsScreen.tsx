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
import { ProjectsSettings } from '../projects/ProjectsSettings';
import { RulesSettings } from '../rules/RulesSettings';
import { DailyTemplateSettings } from '../sections/notes/DailyTemplateSettings';
import { TeamsSettings } from '../sections/teams/TeamsSettings';
import { AccountsPanel } from './AccountsPanel';
import { AutonomyPanel } from './AutonomyPanel';
import { AresSettings } from './ares/AresSettings';
import { Diagnostics } from './Diagnostics';
import { GitHubWatchPanel } from './github/GitHubWatchPanel';
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

/** Settings, opened from the header (or `,`) as a temporary tab. `open` while it is on screen. */
export function SettingsScreen({ open = true }: { open?: boolean }) {
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
            <b>Appearance, Projects, start-up and security</b> · kept on this machine
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
      <ProjectsSettings no="02" />
      <SettingsGroup no="03" title="Start-up" note="Tray">
        <StartAtLogin />
      </SettingsGroup>
      <AccountsPanel no="04" />
      <SecurityPanel no="05" />
      <Diagnostics no="06" />
      <SettingsGroup no="07" title="Design" note="Industrial design system">
        <SettingRow label="Design gallery" description="Every token and component, dark and light.">
          <Button asChild>
            <a href="#/design" className="no-underline">
              Open the design gallery →
            </a>
          </Button>
        </SettingRow>
      </SettingsGroup>
      <AresSettings no="08" usageNo="09" />
      <AutonomyPanel no="10" shown={open} />
      <DailyTemplateSettings no="11" />
      <RulesSettings no="12" shown={open} />
      <GitHubWatchPanel no="13" />
      <TeamsSettings no="14" shown={open} />
    </Sheet>
  );
}
