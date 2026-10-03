import type { Project } from '@commander/domain';
import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  Input,
} from '@commander/ui';
import { type FormEvent, useEffect, useId, useState } from 'react';
import type { ItemStoreClient } from '../../item-store/client';
import { AccentPicker } from '../AccentPicker';
import { changeWithUndo } from '../change-with-undo';
import { useProjects } from '../context';
import { SideCard } from './SideCard';

const label =
  'mb-1.5 block font-mono text-label leading-none font-semibold uppercase tracking-label text-muted';
const part = 'flex flex-col gap-3 border-b border-line2 px-2.5 py-3 last:border-b-0';

/**
 * Managing a Project from its page: rename and recode it (codes stay unique), recolour it, archive
 * or unarchive it, and merge it with another Project. Every change can be undone from its toast.
 * `onChanged` reloads the page's Items after a change that moves them (a merge, or undoing one).
 */
export function ManageProject({
  project,
  itemStore,
  onChanged,
}: {
  project: Project;
  itemStore: ItemStoreClient;
  onChanged: () => void;
}) {
  return (
    <SideCard label="Manage the Project" title="Manage" note={project.code}>
      <DetailsForm project={project} />
      <ArchivePart project={project} />
      <MergePart project={project} itemStore={itemStore} onChanged={onChanged} />
    </SideCard>
  );
}

function DetailsForm({ project }: { project: Project }) {
  const { projects, archived, change } = useProjects();
  const [name, setName] = useState(project.name);
  const [code, setCode] = useState(project.code);
  const [accent, setAccent] = useState(project.accent);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ids = { name: useId(), code: useId(), error: useId() };
  // Follows the Project when it changes elsewhere (an undo, another page).
  useEffect(() => {
    setName(project.name);
    setCode(project.code);
    setAccent(project.accent);
  }, [project.name, project.code, project.accent]);

  const changes = {
    ...(name.trim() !== project.name && { name }),
    ...(code.trim().toUpperCase() !== project.code && { code }),
    ...(accent !== project.accent && { accent }),
  };
  const dirty = Object.keys(changes).length > 0;
  const used = new Set(
    [...projects, ...archived].filter((other) => other.id !== project.id).map((other) => other.accent),
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty) return;
    setSaving(true);
    const done = await changeWithUndo(
      change,
      { type: 'update', projectId: project.id, changes },
      (saved) => `Saved ${saved.project?.code ?? ''} ${saved.project?.name ?? ''}`,
      { refused: setError },
    );
    if (done) setError(null);
    setSaving(false);
  };

  return (
    <form aria-label="Name, code and accent" onSubmit={submit} className={part}>
      <div className="flex items-end gap-2.5">
        <div className="min-w-0 flex-1">
          <label htmlFor={ids.name} className={label}>
            Name
          </label>
          <Input
            id={ids.name}
            value={name}
            autoComplete="off"
            aria-describedby={error ? ids.error : undefined}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor={ids.code} className={label}>
            Badge code
          </label>
          <Input
            id={ids.code}
            font="mono"
            value={code}
            maxLength={2}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error?.includes('code') || undefined}
            aria-describedby={error ? ids.error : undefined}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            className="w-14"
          />
        </div>
      </div>
      <AccentPicker value={accent} onChange={setAccent} used={used} />
      {error && (
        <p id={ids.error} role="alert" className="m-0 text-note leading-[19px] font-semibold text-signal-ink">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2.5">
        <Button type="submit" variant="primary" disabled={!dirty || saving}>
          Save
        </Button>
        {dirty && code.trim().length === 2 && (
          <span className="flex items-center gap-2 font-mono text-label uppercase tracking-label text-muted">
            <Badge code={code} accent={accent} aria-hidden="true" /> New Badge
          </span>
        )}
      </div>
    </form>
  );
}

function ArchivePart({ project }: { project: Project }) {
  const { change } = useProjects();
  const toggle = () =>
    changeWithUndo(
      change,
      { type: project.archived ? 'unarchive' : 'archive', projectId: project.id },
      `${project.archived ? 'Unarchived' : 'Archived'} ${project.code} ${project.name}`,
    );
  return (
    <div className={part}>
      <p className="m-0 text-note leading-[19px] text-muted">
        {project.archived
          ? 'Archived: off the filter bar and the Badge picker. Its Items keep their Badges.'
          : 'Archiving takes it off the filter bar and the Badge picker. Its Items keep their Badges.'}
      </p>
      <div>
        <Button onClick={toggle}>{project.archived ? 'Unarchive' : 'Archive'}</Button>
      </div>
    </div>
  );
}

function MergePart({
  project,
  itemStore,
  onChanged,
}: {
  project: Project;
  itemStore: ItemStoreClient;
  onChanged: () => void;
}) {
  const { projects, archived, change, openPage, projectById } = useProjects();
  const others = [...projects, ...archived].filter((other) => other.id !== project.id);
  const [otherId, setOtherId] = useState('');
  const [keep, setKeep] = useState<'this' | 'other'>('this');
  const [confirming, setConfirming] = useState(false);
  const [moving, setMoving] = useState<number | null>(null);
  const ids = { other: useId(), keep: useId() };
  const other = projectById(otherId);
  const kept = keep === 'this' ? project : other;
  const merged = keep === 'this' ? other : project;

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    if (!merged || !kept) return;
    setMoving(null);
    setConfirming(true);
    const items = await itemStore({ op: 'query', query: { projectId: merged.id, limit: 1000 } });
    setMoving(items.length);
  };

  const merge = async () => {
    if (!merged || !kept) return;
    setConfirming(false);
    const done = await changeWithUndo(
      change,
      { type: 'merge', projectId: merged.id, into: kept.id },
      (result) =>
        `Merged ${merged.code} into ${kept.code}: ${result.moved} Item${result.moved === 1 ? '' : 's'} moved`,
      { after: onChanged },
    );
    if (!done) return;
    setOtherId('');
    if (merged.id === project.id) openPage?.(kept.id);
  };

  return (
    <form aria-label="Merge" onSubmit={ask} className={part}>
      <p className="m-0 text-note leading-[19px] text-muted">
        Merging moves every Item of one Project into the other, keeping how each was filed. The other
        disappears; undo brings it back.
      </p>
      <div>
        <label htmlFor={ids.other} className={label}>
          Merge with
        </label>
        <select
          id={ids.other}
          value={otherId}
          onChange={(event) => setOtherId(event.target.value)}
          className="h-7.5 w-full border border-line bg-sheet px-2 font-sans text-note text-ink outline-none focus-visible:border-ink"
        >
          <option value="">Choose a Project…</option>
          {others.map((option) => (
            <option key={option.id} value={option.id}>
              {option.code} · {option.name}
              {option.archived ? ' (archived)' : ''}
            </option>
          ))}
        </select>
      </div>
      {other && (
        <div role="radiogroup" aria-labelledby={ids.keep} className="flex flex-col gap-1.5">
          <span id={ids.keep} className={cn(label, 'mb-0')}>
            Keep
          </span>
          {(
            [
              ['this', project],
              ['other', other],
            ] as const
          ).map(([value, option]) => (
            <label key={value} className="flex cursor-pointer items-center gap-2 text-note text-ink">
              <input
                type="radio"
                name={ids.keep}
                checked={keep === value}
                onChange={() => setKeep(value)}
                aria-label={`Keep ${option.name}`}
                className="m-0 accent-(--ink)"
              />
              <Badge code={option.code} accent={option.accent} project={option.name} />
              {option.name}
            </label>
          ))}
        </div>
      )}
      <div>
        <Button type="submit" disabled={!other}>
          Merge…
        </Button>
      </div>
      <Dialog open={confirming && !!merged && !!kept} onOpenChange={setConfirming}>
        {merged && kept && (
          <DialogContent aria-describedby={undefined}>
            <DialogHeader partNumber="MRG">
              <DialogTitle>
                Merge {merged.name} into {kept.name}?
              </DialogTitle>
            </DialogHeader>
            <DialogBody>
              <DialogHeading className="flex items-center gap-3">
                <Badge code={merged.code} accent={merged.accent} project={merged.name} />→
                <Badge code={kept.code} accent={kept.accent} project={kept.name} />
                {kept.name}
              </DialogHeading>
              <DialogDescription>
                {moving === null
                  ? 'Counting its Items…'
                  : `${moving} Item${moving === 1 ? '' : 's'} move${moving === 1 ? 's' : ''} into ${kept.name}, each keeping how it was filed, and ${merged.name} disappears. Undo puts everything back.`}
              </DialogDescription>
            </DialogBody>
            <DialogFooter>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
              <Button variant="primary" onClick={merge}>
                Merge
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </form>
  );
}
