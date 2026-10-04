import './notes.css';
import './formatting.css';
import { toast } from '@commander/ui';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { SettingRow, SettingsGroup } from '../../settings/parts';
import { useOutlineLinks } from './BlockLinks';
import { TEMPLATE_DAY, templateIn } from './daily-template';
import { dayKey } from './days';
import { MarkdownCopySetting } from './MarkdownCopySetting';
import { createNotebook } from './notebook';
import { focusText, OutlineContext, type OutlineControls, OutlineView } from './OutlineView';
import type { Caret } from './outline';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Settings → Notes → Daily template: the Blocks each new day's Daily Note starts with, edited in the
 * Notes Section's own outliner (same keys, nesting and folds). Changes reach days made afterwards.
 */
export function DailyTemplateSettings({ no }: { no: string }) {
  const [notebook] = useState(() =>
    createNotebook(templateIn(window.commander.itemStore), {
      today: TEMPLATE_DAY,
      onError: (message) => toast(`Daily template: ${message}`),
    }),
  );
  const state = useSyncExternalStore(notebook.subscribe, notebook.snapshot);
  useEffect(() => {
    void notebook.start();
  }, [notebook]);
  // Typing held back for a pause is saved before Commander quits.
  useEffect(() => window.commander.onSaveBeforeQuit?.(() => notebook.flush()), [notebook]);

  // The caret goes where the Notebook says, once the Block is on screen.
  const pendingFocus = useRef<Caret | null>(null);
  const applyFocus = useCallback(() => {
    const caret = pendingFocus.current;
    if (!caret) return;
    const element = document.querySelector<HTMLElement>(`[data-block-id="${caret.id}"]`);
    if (!element) return;
    pendingFocus.current = null;
    focusText(element, caret.offset);
  }, []);
  useLayoutEffect(applyFocus);
  // `[[` in the template links Projects only: a template has no day of its own to count from.
  const links = useOutlineLinks(dayKey(new Date()), undefined, { days: false });
  const controls = useMemo<OutlineControls>(
    () => ({
      notebook,
      focus(caret) {
        if (!caret) return;
        pendingFocus.current = caret;
        requestAnimationFrame(applyFocus);
      },
      links,
    }),
    [notebook, applyFocus, links],
  );

  const outline = state.days[0]?.outline;
  return (
    <SettingsGroup
      no={no}
      title="Notes"
      note={outline ? `Template · ${pad(outline.size)} Blocks` : 'Template'}
    >
      <SettingRow
        label="Daily template"
        description="Each new day’s Daily Note starts with a copy of these Blocks. Edit them as in Notes: Enter, Tab and Shift+Tab. Changes apply from the next new day; today and earlier days keep what they have."
      >
        <OutlineContext.Provider value={controls}>
          <div className="max-w-[640px] pl-10" data-notes-stream="" data-testid="daily-template">
            {outline && (
              <OutlineView day={TEMPLATE_DAY} outline={outline} placeholder="Empty. New days start blank." />
            )}
          </div>
        </OutlineContext.Provider>
      </SettingRow>
      <MarkdownCopySetting />
    </SettingsGroup>
  );
}
