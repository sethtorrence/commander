import './notes.css';
import './formatting.css';
import { isMeetingsBlockText } from '@commander/domain';
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
import { createNotebook } from './notebook';
import { focusText, OutlineContext, type OutlineControls, OutlineView } from './OutlineView';
import type { Caret } from './outline';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Settings → Notes → Daily template: the Blocks each new day's Daily Note starts with, edited in the
 * Notes Section's own outliner (same keys, line styles, nesting and folds). Changes reach days made
 * afterwards.
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
  // Meeting chips go under a top-level "Meetings" Block (#128): say so, and whether the template has one.
  const hasMeetings =
    !outline || [...outline.values()].some((block) => !block.parentId && isMeetingsBlockText(block.text));
  return (
    <SettingsGroup
      no={no}
      title="Notes"
      note={outline ? `Template · ${pad(outline.size)} Blocks` : 'Template'}
    >
      <SettingRow
        label="Daily template"
        description="Each new day’s Daily Note starts with a copy of these Blocks. Write them as in Notes: “## ” makes a subheading, “- ” a bullet and “1. ” a numbered item, and Tab nests list items. Changes apply from the next new day; today and earlier days keep what they have."
      >
        <OutlineContext.Provider value={controls}>
          <div className="max-w-[640px] pl-10" data-notes-stream="" data-testid="daily-template">
            {outline && (
              <OutlineView day={TEMPLATE_DAY} outline={outline} placeholder="Empty. New days start blank." />
            )}
          </div>
        </OutlineContext.Provider>
      </SettingRow>
      <SettingRow
        label="Meeting chips"
        description="Today’s meetings go under a top-level “Meetings” Block in today’s Daily Note, one chip each, in time order, each a quote ready for its notes. A day without that Block gets no chips."
      >
        <p className="m-0 text-note leading-[19px] text-muted" data-testid="meeting-chips-setting">
          {hasMeetings
            ? 'The daily template has a “Meetings” Block, so each new day gets its meetings.'
            : 'The daily template has no top-level “Meetings” Block, so new days get no meeting chips. Add one above to bring them back.'}
        </p>
      </SettingRow>
    </SettingsGroup>
  );
}
