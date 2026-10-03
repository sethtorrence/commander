import type { Project } from '@commander/domain';
import { Badge, Button, cn, Input, PROJECT_ACCENTS, toast } from '@commander/ui';
import { type FormEvent, useId, useState } from 'react';
import { SettingRow, SettingsGroup } from '../settings/parts';
import { useProjects } from './context';

const pad = (n: number) => String(n).padStart(2, '0');

/** The first palette accent no Project uses yet, or the first of the palette once all are used. */
export function firstUnusedAccent(projects: readonly Pick<Project, 'accent'>[]): string {
  const used = new Set(projects.map((project) => project.accent));
  return (PROJECT_ACCENTS.find((accent) => !used.has(accent.name)) ?? PROJECT_ACCENTS[0])?.name ?? 'blue';
}

/** Settings → Projects: the Projects in their order, and New Project. */
export function ProjectsSettings({ no }: { no: string }) {
  const { projects } = useProjects();
  return (
    <SettingsGroup no={no} title="Projects" note={`${pad(projects.length)} Projects`}>
      {projects.length ? (
        <ul aria-label="Projects" className="m-0 list-none p-0">
          {projects.map((project, index) => (
            <li
              key={project.id}
              className="relative grid grid-cols-[25px_minmax(0,260px)_minmax(0,1fr)] items-center gap-4 border-b border-line2 py-2.5 pr-6 pl-13"
            >
              <span className="absolute left-0 w-10 text-center font-mono text-label font-medium text-faint">
                {pad(index + 1)}
              </span>
              <Badge code={project.code} accent={project.accent} project={project.name} />
              <span className="truncate text-row leading-[22px] font-semibold text-ink">{project.name}</span>
              <span className="font-mono text-label leading-none font-medium uppercase tracking-label text-muted">
                Code {project.code} · {project.accent}
                {index < 9 && <> · P then {index + 1}</>}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hatch m-0 border-b border-line2 py-3 pr-5 pl-13 text-heading text-faint">
          No Projects yet. Every Item is Unfiled until you make one.
        </p>
      )}
      <SettingRow
        label="New Project"
        description="A name, a two-letter Badge code and an accent. The Badge marks the Project’s Items everywhere."
      >
        <NewProjectForm />
      </SettingRow>
    </SettingsGroup>
  );
}

function NewProjectForm() {
  const { projects, create } = useProjects();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  // The accent the User picked, or null to follow the first unused one.
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const accent = picked ?? firstUnusedAccent(projects);
  const used = new Set(projects.map((project) => project.accent));
  const ids = { name: useId(), code: useId(), accents: useId(), error: useId() };

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
      setError(reason instanceof Error ? reason.message : String(reason));
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
      <div>
        <span id={ids.accents} className={label}>
          Accent
        </span>
        <div role="radiogroup" aria-labelledby={ids.accents} className="flex flex-wrap gap-2">
          {PROJECT_ACCENTS.map((option) => (
            <input
              key={option.name}
              type="radio"
              name={ids.accents}
              checked={option.name === accent}
              onChange={() => setPicked(option.name)}
              aria-label={`${option.name}${used.has(option.name) ? ' (in use)' : ''}`}
              title={`${option.name}${used.has(option.name) ? ' · in use' : ''}`}
              className={cn(
                'm-0 size-7.5 cursor-pointer appearance-none border border-line hover:border-ink checked:outline-2 checked:outline-offset-2 checked:outline-ink checked:outline-solid',
                used.has(option.name) && 'opacity-45',
              )}
              style={{ background: `var(--accent-${option.name})` }}
            />
          ))}
        </div>
      </div>
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
