import { LABEL_FIELD, type LinearIssueDetail } from '@commander/domain';
import {
  CheckIcon,
  cn,
  Kbd,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@commander/ui';
import { type KeyboardEvent, type ReactNode, useEffect, useState } from 'react';
import type { PickerOptions } from './editing';
import { PRIORITY_NAMES, PriorityIcon, StateIcon } from './glyphs';

/*
  The detail pane's editors for an issue's synced fields (Two-way sync): a picker each for state,
  assignee, priority, Linear project, cycle and labels, and inputs for the due date and estimate.
  Each shows the value as the read-only pane did, and hands a change over as the synced fields it
  sets (`{ priority: 1 }`, `{ 'label:<id>': label }`), so the change carries nothing else.
*/

export type FieldEdit = (fields: Record<string, unknown>) => void;

// Radix Select values are strings: the choice that clears a field.
const NONE = '__none';

const trigger =
  'h-auto w-auto max-w-full justify-end gap-2 border-0 bg-transparent p-0 text-right hover:border-0 hover:underline hover:decoration-line hover:underline-offset-2 data-[state=open]:underline [&>svg]:size-2.5';

/** One picker, shown as the value it holds. Focus goes back to the pane once a choice is made. */
function Picker({
  label,
  value,
  onChange,
  display,
  children,
  afterChoice,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  display: ReactNode;
  children: ReactNode;
  afterChoice: () => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className={trigger}>
        <SelectValue placeholder={display}>{display}</SelectValue>
      </SelectTrigger>
      <SelectContent
        align="end"
        onCloseAutoFocus={(event) => {
          // So the Section's keys (Ctrl+Z, Esc, j/k) work straight after a choice.
          event.preventDefault();
          afterChoice();
        }}
      >
        {children}
      </SelectContent>
    </Select>
  );
}

const optionRow = 'flex items-center gap-2';

export function StatePicker({
  detail,
  options,
  onEdit,
  display,
  afterChoice,
}: {
  detail: LinearIssueDetail;
  options: PickerOptions;
  onEdit: FieldEdit;
  display: ReactNode;
  afterChoice: () => void;
}) {
  return (
    <Picker
      label="State"
      value={detail.state.id}
      display={display}
      afterChoice={afterChoice}
      onChange={(id) => {
        const state = options.states.find((each) => each.id === id);
        if (state && state.id !== detail.state.id) onEdit({ state });
      }}
    >
      {options.states.map((state) => (
        <SelectItem key={state.id} value={state.id}>
          <span className={optionRow}>
            <span aria-hidden="true" className="flex">
              <StateIcon type={state.type} />
            </span>
            {state.name}
          </span>
        </SelectItem>
      ))}
    </Picker>
  );
}

export function PriorityPicker({
  detail,
  onEdit,
  display,
  afterChoice,
}: {
  detail: LinearIssueDetail;
  onEdit: FieldEdit;
  display: ReactNode;
  afterChoice: () => void;
}) {
  return (
    <Picker
      label="Priority"
      value={String(detail.priority)}
      display={display}
      afterChoice={afterChoice}
      onChange={(value) => {
        const priority = Number(value);
        if (priority !== detail.priority) onEdit({ priority });
      }}
    >
      {[0, 1, 2, 3, 4].map((priority) => (
        <SelectItem key={priority} value={String(priority)}>
          <span className={optionRow}>
            <span aria-hidden="true" className="flex">
              <PriorityIcon priority={priority} />
            </span>
            {PRIORITY_NAMES[priority]}
          </span>
        </SelectItem>
      ))}
    </Picker>
  );
}

export function AssigneePicker({
  detail,
  options,
  me,
  onEdit,
  display,
  afterChoice,
}: {
  detail: LinearIssueDetail;
  options: PickerOptions;
  /** The User's own Linear user id in the issue's workspace. */
  me: string | null;
  onEdit: FieldEdit;
  display: ReactNode;
  afterChoice: () => void;
}) {
  const members = [...options.members].sort((a, b) => Number(b.id === me) - Number(a.id === me));
  return (
    <Picker
      label="Assignee"
      value={detail.assignee?.id ?? NONE}
      display={display}
      afterChoice={afterChoice}
      onChange={(id) => {
        if (id === (detail.assignee?.id ?? NONE)) return;
        onEdit({ assignee: id === NONE ? null : (members.find((member) => member.id === id) ?? null) });
      }}
    >
      <SelectItem value={NONE}>Unassigned</SelectItem>
      {members.map((member) => (
        <SelectItem key={member.id} value={member.id}>
          {member.id === me ? `You (${member.name})` : member.name}
        </SelectItem>
      ))}
    </Picker>
  );
}

export function LinearProjectPicker({
  detail,
  options,
  onEdit,
  display,
  afterChoice,
}: {
  detail: LinearIssueDetail;
  options: PickerOptions;
  onEdit: FieldEdit;
  display: ReactNode;
  afterChoice: () => void;
}) {
  return (
    <Picker
      label="Linear project"
      value={detail.linearProject?.id ?? NONE}
      display={display}
      afterChoice={afterChoice}
      onChange={(id) => {
        if (id === (detail.linearProject?.id ?? NONE)) return;
        const linearProject = options.linearProjects.find((each) => each.id === id) ?? null;
        onEdit({ linearProject: id === NONE ? null : linearProject });
      }}
    >
      <SelectItem value={NONE}>No Linear project</SelectItem>
      {options.linearProjects.map((each) => (
        <SelectItem key={each.id} value={each.id}>
          {each.name}
        </SelectItem>
      ))}
    </Picker>
  );
}

export const cycleName = (cycle: NonNullable<LinearIssueDetail['cycle']>) =>
  [`Cycle ${cycle.number}`, cycle.name].filter(Boolean).join(' · ');

export function CyclePicker({
  detail,
  options,
  onEdit,
  display,
  afterChoice,
}: {
  detail: LinearIssueDetail;
  options: PickerOptions;
  onEdit: FieldEdit;
  display: ReactNode;
  afterChoice: () => void;
}) {
  return (
    <Picker
      label="Cycle"
      value={detail.cycle?.id ?? NONE}
      display={display}
      afterChoice={afterChoice}
      onChange={(id) => {
        if (id === (detail.cycle?.id ?? NONE)) return;
        onEdit({ cycle: id === NONE ? null : (options.cycles.find((each) => each.id === id) ?? null) });
      }}
    >
      <SelectItem value={NONE}>No cycle</SelectItem>
      {options.cycles.map((cycle) => (
        <SelectItem key={cycle.id} value={cycle.id}>
          {cycleName(cycle)}
        </SelectItem>
      ))}
    </Picker>
  );
}

/** Labels: each choice adds or takes off one label (sent to Linear as a delta). */
export function LabelsPicker({
  detail,
  options,
  onEdit,
  display,
  afterChoice,
}: {
  detail: LinearIssueDetail;
  options: PickerOptions;
  onEdit: FieldEdit;
  display: ReactNode;
  afterChoice: () => void;
}) {
  const on = new Set(detail.labels.map((label) => label.id));
  return (
    <Picker
      label="Labels"
      // No choice is ever the picker's value: choosing a label toggles it.
      value=""
      display={display}
      afterChoice={afterChoice}
      onChange={(id) => {
        const label = options.labels.find((each) => each.id === id);
        if (label) onEdit({ [`${LABEL_FIELD}${label.id}`]: on.has(label.id) ? null : label });
      }}
    >
      {options.labels.map((label) => (
        <SelectItem key={label.id} value={label.id} aria-checked={on.has(label.id)}>
          <span className={optionRow}>
            <i
              aria-hidden="true"
              className="inline-block size-2 border border-line"
              style={{ background: label.color }}
            />
            {label.name}
            {on.has(label.id) && <CheckIcon className="ml-auto size-3" />}
          </span>
        </SelectItem>
      ))}
    </Picker>
  );
}

const inline =
  'h-6 border-0 border-b border-transparent bg-transparent p-0 text-right font-mono text-label-lg font-semibold uppercase tracking-tag text-ink hover:border-line focus-visible:border-ink focus-visible:outline-none';

export function DueDateInput({ detail, onEdit }: { detail: LinearIssueDetail; onEdit: FieldEdit }) {
  return (
    <input
      type="date"
      aria-label="Due date"
      value={detail.dueDate ?? ''}
      onChange={(event) => {
        const dueDate = event.target.value || null;
        if (dueDate !== detail.dueDate) onEdit({ dueDate });
      }}
      className={cn(inline, 'w-[9.5rem] [color-scheme:inherit]')}
    />
  );
}

/** The estimate: saved on Enter or leaving the field; empty clears it. */
export function EstimateInput({ detail, onEdit }: { detail: LinearIssueDetail; onEdit: FieldEdit }) {
  const shown = detail.estimate === null ? '' : String(detail.estimate);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const save = () => {
    const trimmed = text.trim();
    const estimate = trimmed === '' ? null : Number(trimmed);
    if (estimate !== null && (!Number.isFinite(estimate) || estimate < 0)) {
      setText(shown);
      return;
    }
    if (estimate !== detail.estimate) onEdit({ estimate });
  };
  return (
    <span className="flex items-center justify-end gap-1.5">
      <input
        type="number"
        min={0}
        step={1}
        inputMode="numeric"
        aria-label="Estimate"
        placeholder="—"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save();
          if (event.key === 'Escape') setText(shown);
        }}
        className={cn(inline, 'w-12 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none')}
      />
      <span className="text-muted">{detail.estimate === 1 ? 'point' : 'points'}</span>
    </span>
  );
}

/** The comment box under the comments: Ctrl+Enter (or Comment) posts. */
export function CommentBox({ onComment }: { onComment: (body: string) => Promise<boolean> }) {
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const post = async () => {
    if (!body.trim() || posting) return;
    setPosting(true);
    const posted = await onComment(body);
    setPosting(false);
    if (posted) setBody('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void post();
    }
  };
  return (
    <div className="mt-2 border border-line">
      <textarea
        aria-label="New comment"
        placeholder="Write a comment…"
        value={body}
        rows={3}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
        className="block w-full resize-y border-0 bg-sheet px-3.5 py-2.5 font-sans text-[14px] text-ink caret-signal placeholder:text-faint focus-visible:outline-none"
      />
      <div className="flex items-center justify-end gap-2.5 border-t border-line2 px-2.5 py-1.5">
        <span className="flex items-center gap-1.5 font-mono text-label uppercase tracking-label text-faint">
          <Kbd>Ctrl ↵</Kbd> posts
        </span>
        <button
          type="button"
          disabled={!body.trim() || posting}
          onClick={() => void post()}
          className="cursor-pointer border border-ink bg-ink px-3 py-1 font-mono text-label-lg font-semibold uppercase tracking-label text-sheet disabled:cursor-not-allowed disabled:opacity-40"
        >
          Comment
        </button>
      </div>
    </div>
  );
}
