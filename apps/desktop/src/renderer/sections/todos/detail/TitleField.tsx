import { useEffect, useRef, useState } from 'react';

/**
 * The detail pane's title, edited in place. Enter or leaving the field saves it; Esc puts it back.
 * Enter and Esc stay in the field (they don't reach the Section's shortcuts). Line breaks become
 * spaces: a title is one line.
 */
export function TitleField({ title, onSave }: { title: string; onSave: (title: string) => void }) {
  const [draft, setDraft] = useState(title);
  // Set once Enter or Esc has dealt with the edit, so leaving the field doesn't save it again.
  const settled = useRef(false);

  useEffect(() => setDraft(title), [title]);

  const save = () => {
    if (draft.trim() && draft.trim() !== title) onSave(draft);
    else setDraft(title);
  };

  return (
    <textarea
      aria-label="Title"
      rows={1}
      spellCheck
      value={draft}
      onChange={(event) => setDraft(event.target.value.replace(/\s*\n\s*/g, ' '))}
      onFocus={() => {
        settled.current = false;
      }}
      onBlur={() => {
        if (!settled.current) save();
        settled.current = false;
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') save();
        else if (event.key === 'Escape') setDraft(title);
        else return;
        event.preventDefault();
        settled.current = true;
        event.currentTarget.blur();
      }}
      className="mt-2 mb-1 block w-full resize-none border-0 bg-transparent p-0 font-sans text-subtitle leading-[1.05] font-extrabold tracking-[-0.01em] text-ink caret-signal outline-none [field-sizing:content] font-stretch-[115%] focus:shadow-[0_2px_0_var(--signal)]"
    />
  );
}
