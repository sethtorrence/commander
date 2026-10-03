import { Kbd, ThemeToggle } from '@commander/ui';
import type { SectionDefinition } from '../sections';

export interface NotebookTabsProps {
  sections: readonly SectionDefinition[];
  /** The open Section's id, or "settings". */
  open: string;
  onOpen: (id: string) => void;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
}

// Sliders, drawn like the prototypes' glyphs: square caps, mitred corners.
function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-3.5" fill="none" stroke="currentColor">
      <path d="M4 7h16M4 17h16" strokeWidth={1.5} strokeLinecap="square" />
      <rect x="7" y="4.5" width="4" height="5" fill="var(--bg)" strokeWidth={1.5} />
      <rect x="13" y="14.5" width="4" height="5" fill="var(--bg)" strokeWidth={1.5} />
    </svg>
  );
}

/**
 * The numbered notebook index tabs along the sheet edge (.tabs). Settings opens as a temporary tab
 * with × after the Sections, like a Project page does in the prototype.
 */
export function NotebookTabs({ sections, open, onOpen, onOpenSettings, onCloseSettings }: NotebookTabsProps) {
  return (
    <nav className="f-tabs" aria-label="Sections">
      {sections.map((section, index) => (
        <button
          key={section.id}
          type="button"
          className="f-tab"
          data-section={section.id}
          aria-label={section.label}
          aria-current={open === section.id ? 'page' : undefined}
          aria-keyshortcuts={String(index + 1)}
          title={`${section.label} · press ${index + 1}`}
          onClick={() => onOpen(section.id)}
        >
          <span className="tn">{index + 1}</span>
          <span className="tlb">{section.label}</span>
          <span className="tc" />
        </button>
      ))}
      {open === 'settings' && (
        // A div, so the close button isn't nested in another button.
        <div className="f-tab temp" data-section="settings" aria-current="page" title="Settings · Esc closes">
          <span className="tn">,</span>
          <span className="tlb">Settings</span>
          <button type="button" className="tx" aria-label="Close Settings" onClick={onCloseSettings}>
            ×
          </button>
        </div>
      )}
      <span className="tsp" />
      <span className="tk" aria-hidden="true">
        <Kbd>1</Kbd>–<Kbd>{sections.length}</Kbd> Sections
      </span>
      <div className="tools">
        <ThemeToggle />
        {/* While Settings is open its tab stands in for this button, leaving the Section tabs room. */}
        {open !== 'settings' && (
          <button
            type="button"
            onClick={onOpenSettings}
            aria-keyshortcuts=","
            title="Settings · press ,"
            aria-label="Settings"
            className="flex h-7.5 cursor-pointer items-center gap-2 border border-line bg-transparent px-2.5 font-mono text-label leading-none font-semibold uppercase tracking-caps text-muted hover:border-ink hover:text-ink"
          >
            <SettingsIcon />
            <span className="f-tool-label">Settings</span>
          </button>
        )}
      </div>
    </nav>
  );
}
