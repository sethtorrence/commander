import type { Project } from '@commander/domain';
import { Badge, Button, cn, Input, PROJECT_ACCENTS, toast } from '@commander/ui';
import { type DragEvent, type FormEvent, useId, useState } from 'react';
import { SettingRow, SettingsGroup } from '../settings/parts';
import { AccentPicker } from './AccentPicker';
import { changeWithUndo, errorText } from './change-with-undo';
import { useProjects } from './context';

const pad = (n: number) => String(n).padStart(2, '0');

/** The first palette accent no Project uses yet, or the first of the palette once all are used. */
export function firstUnusedAccent(projects: readonly Pick<Project, 'accent'>[]): string {
  const used = new Set(projects.map((project) => project.accent));
  return (PROJECT_ACCENTS.find((accent) => !used.has(accent.name)) ?? PROJECT_ACCENTS[0])?.name ?? 'blue';
}

/** The ids in a new order: `id` moved to `to` (an index in the list as it is now). */
export function moved(ids: readonly string[], id: string, to: number): string[] {
  const rest = ids.filter((other) => other !== id);
  rest.splice(Math.max(0, Math.min(rest.length, to)), 0, id);
  return rest;
}

/**
 * Settings → Projects: the Projects in their order (drag a row, or use its arrows, to reorder: the
 * order drives the filter bar and the `p` number keys), each with its page; the archived Projects,
 * with Unarchive; and New Project.
 */
export function ProjectsSettings({ no }: { no: string }) {
  const { projects, archived } = useProjects();
  return (
    <SettingsGroup
      no={no}
      title="Projects"
      note={`${pad(projects.length)} Projects${archived.length ? ` · ${pad(archived.length)} archived` : ''}`}
    >
      {projects.length ? (
        <ProjectOrder />
      ) : (
        <p className="hatch m-0 border-b border-line2 py-3 pr-5 pl-13 text-heading text-faint">
          {archived.length
            ? 'Every Project is archived. Unarchive one below, or make a new one.'
            : 'No Projects yet. Every Item is Unfiled until you make one.'}
        </p>
      )}
      {archived.length > 0 && <ArchivedProjects />}
      <SettingRow
        label="New Project"
        description="A name, a two-letter Badge code and an accent. The Badge marks the Project’s Items everywhere."
      >
        <NewProjectForm />
      </SettingRow>
    </SettingsGroup>
  );
}

const rowClass =
  'relative grid grid-cols-[25px_minmax(0,260px)_minmax(0,1fr)_auto] items-center gap-4 border-b border-line2 py-2 pr-6 pl-13';
const metaClass = 'font-mono text-label leading-none font-medium uppercase tracking-label text-muted';

function ProjectOrder() {
  const { projects, change, openPage } = useProjects();
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const ids = projects.map((project) => project.id);

  const reorder = (id: string, to: number) => {
    const next = moved(ids, id, to);
    if (next.every((other, index) => other === ids[index])) return;
    const project = projects.find((p) => p.id === id);
    changeWithUndo(
      change,
      { type: 'reorder', projectIds: next },
      `Moved ${project?.code ?? 'the Project'} to ${next.indexOf(id) + 1}`,
    );
  };

  const dropAt = (event: DragEvent, index: number) => {
    event.preventDefault();
    const id = dragged ?? event.dataTransfer.getData('text/plain');
    setDragged(null);
    setOver(null);
    if (id) reorder(id, index);
  };

  return (
    <ul aria-label="Projects" className="m-0 list-none p-0">
      {projects.map((project, index) => (
        <li
          key={project.id}
          draggable
          onDragStart={(event) => {
            setDragged(project.id);
            event.dataTransfer.setData('text/plain', project.id);
            event.dataTransfer.effectAllowed = 'move';
          }}
          onDragEnd={() => {
            setDragged(null);
            setOver(null);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(index);
          }}
          onDrop={(event) => dropAt(event, index)}
          className={cn(
            rowClass,
            'cursor-grab',
            dragged === project.id && 'opacity-45',
            over === index && dragged !== project.id && 'shadow-[inset_0_2px_0_var(--ink)]',
          )}
        >
          <span
            className="absolute left-0 w-10 text-center font-mono text-label font-medium text-faint"
            title="Drag to reorder"
          >
            {pad(index + 1)}
          </span>
          <Badge code={project.code} accent={project.accent} project={project.name} />
          <span className="truncate text-row leading-[22px] font-semibold text-ink">{project.name}</span>
          <span className={metaClass}>
            Code {project.code} ·{' '}
            {project.accent.startsWith('#') ? `custom ${project.accent}` : project.accent}
            {index < 9 && <> · P then {index + 1}</>}
          </span>
          <span className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Move ${project.name} up`}
              disabled={index === 0}
              onClick={() => reorder(project.id, index - 1)}
            >
              ↑
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Move ${project.name} down`}
              disabled={index === projects.length - 1}
              onClick={() => reorder(project.id, index + 1)}
            >
              ↓
            </Button>
            {openPage && (
              <Button
                size="sm"
                onClick={() => openPage(project.id)}
                aria-label={`Open the ${project.name} page`}
              >
                Page ↗
              </Button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ArchivedProjects() {
  const { archived, change, openPage } = useProjects();
  return (
    <section aria-label="Archived Projects">
      <h3 className="m-0 flex h-7 items-center border-b border-line2 pr-6 pl-13 font-mono text-label leading-none font-semibold uppercase tracking-label text-muted">
        Archived · off the filter bar and the Badge picker; their Items keep their Badges
      </h3>
      <ul aria-label="Archived" className="m-0 list-none p-0">
        {archived.map((project) => (
          <li key={project.id} className={rowClass}>
            <Badge
              code={project.code}
              accent={project.accent}
              project={project.name}
              className="opacity-60"
            />
            <span className="truncate text-row leading-[22px] font-semibold text-muted">{project.name}</span>
            <span className={metaClass}>Code {project.code} · archived</span>
            <span className="flex items-center gap-1">
              <Button
                size="sm"
                onClick={() =>
                  changeWithUndo(
                    change,
                    { type: 'unarchive', projectId: project.id },
                    `Unarchived ${project.code} ${project.name}`,
                  )
                }
              >
                Unarchive
              </Button>
              {openPage && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => openPage(project.id)}
                  aria-label={`Open the ${project.name} page`}
                >
                  Page ↗
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NewProjectForm() {
  const { projects, archived, create } = useProjects();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  // The accent the User picked, or null to follow the first unused one.
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const accent = picked ?? firstUnusedAccent(projects);
  const used = new Set([...projects, ...archived].map((project) => project.accent));
  const ids = { name: useId(), code: useId(), error: useId() };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const project = await create({ name, code, accent });
      toast(`Project created: ${project.code} ${project.name}`);
      setName('');
      setCode('');
      setPicked(null);
      setError(null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
    }
  };

  const label =
    'mb-1.5 block font-mono text-label leading-none font-semibold uppercase tracking-label text-muted';
  return (
    <form aria-label="New Project" onSubmit={submit} className="flex max-w-[640px] flex-col gap-3.5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[200px] flex-1">
          <label htmlFor={ids.name} className={label}>
            Name
          </label>
          <Input
            id={ids.name}
            value={name}
            placeholder="Longtail"
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
            placeholder="LT"
            maxLength={2}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error?.includes('code') || undefined}
            aria-describedby={error ? ids.error : undefined}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            className="w-16"
          />
        </div>
        <div className="flex h-7.5 items-center" aria-hidden="true">
          {code.trim().length === 2 ? (
            <Badge code={code} accent={accent} />
          ) : (
            <Badge kind="unfiled" className="opacity-60" />
          )}
        </div>
      </div>
      <AccentPicker value={accent} onChange={setPicked} used={used} />
      {error && (
        <p id={ids.error} role="alert" className="m-0 text-note leading-[19px] font-semibold text-signal-ink">
          {error}
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={saving}>
          Create Project
        </Button>
      </div>
    </form>
  );
}
