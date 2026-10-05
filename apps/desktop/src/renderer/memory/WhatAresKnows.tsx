import {
  type WhatAresKnows as Known,
  MEMORY_KIND_NAMES,
  type Memory,
  type MemoryAction,
  type MemoryKind,
  type MemorySource,
} from '@commander/domain';
import { Button, cn, Input, toast } from '@commander/ui';
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { requestReveal, useReveal } from '../frame/reveal';
import type { ItemStoreClient } from '../item-store/client';
import { errorText } from '../projects/change-with-undo';
import { useOpenSection } from '../sections/section';
import { goneNote, kindTag, sectionFor } from '../sections/todos/links';
import { SettingsGroup } from '../settings/parts';

/*
  What Ares knows (#74): everything Ares has learned and keeps, grouped by kind (Facts, Examples,
  Preferences, Rules), searchable, each with where it came from and when. The User confirms a fact
  Ares picked up from outside content (until then it is only ever background to him), edits any
  memory's words (which makes them the User's, so confirmed), deletes one (never learned again), and
  adds a preference by hand. A fact whose source was deleted waits at the top for review: Keep or
  Delete. Rules show here too, but are changed only in Settings → Rules. Ctrl+K opens it at a memory
  (`requestReveal(WHAT_ARES_KNOWS, memoryId)`).
*/

/** The reveal channel (frame/reveal.ts) that shows What Ares knows, at a memory when one is named. */
export const WHAT_ARES_KNOWS = 'what-ares-knows';

const KIND_ORDER: MemoryKind[] = ['fact', 'example', 'preference', 'rule'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const metaClass = 'font-mono text-label leading-none font-medium uppercase tracking-label text-muted';

// "4 Oct", or "4 Oct 2025" for another year.
function learnedOn(at: number): string {
  const date = new Date(at);
  const year = date.getFullYear() === new Date().getFullYear() ? '' : ` ${date.getFullYear()}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${year}`;
}

/** Hears what may have changed Memory (Ares's activity, a job finishing), to load it again. */
export type MemoryRefresh = (listener: () => void) => () => void;

export function WhatAresKnows({
  client,
  shown,
  onRefresh,
  no = 'A3',
}: {
  client: ItemStoreClient;
  shown: boolean;
  onRefresh?: MemoryRefresh;
  no?: string;
}) {
  const [query, setQuery] = useState('');
  const [known, setKnown] = useState<Known | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [preference, setPreference] = useState('');
  const latest = useRef(0);
  const root = useRef<HTMLElement>(null);
  const searchId = useId();
  const preferenceId = useId();

  const load = useCallback(() => {
    const asked = ++latest.current;
    client({ op: 'memories', query: query.trim() ? { text: query } : {} }).then(
      (next) => asked === latest.current && setKnown(next),
      (reason: unknown) => toast(errorText(reason)),
    );
  }, [client, query]);

  useEffect(() => {
    if (shown) load();
  }, [shown, load]);
  useEffect(() => (shown && onRefresh ? onRefresh(load) : undefined), [shown, onRefresh, load]);

  useReveal(WHAT_ARES_KNOWS, (memoryId) => {
    setQuery('');
    setFocused(memoryId || null);
    if (!memoryId) requestAnimationFrame(() => root.current?.scrollIntoView({ block: 'start' }));
  });
  useEffect(() => {
    if (!focused || !known) return;
    const frame = requestAnimationFrame(() =>
      root.current
        ?.querySelector(`[data-memory-id="${CSS.escape(focused)}"]`)
        ?.scrollIntoView({ block: 'center' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [focused, known]);

  const change = async (action: MemoryAction, said?: string) => {
    try {
      await client({ op: 'change-memory', action });
      if (said) toast(said);
      load();
      return true;
    } catch (reason) {
      toast(errorText(reason));
      return false;
    }
  };

  const addPreference = async (event: FormEvent) => {
    event.preventDefault();
    if (!preference.trim()) return;
    if (await change({ type: 'add-preference', text: preference }, 'Ares will keep that in mind'))
      setPreference('');
  };

  const memories = known?.memories ?? [];
  const forReview = known?.forReview ?? [];
  const total = memories.length + forReview.length;

  return (
    <SettingsGroup
      ref={root}
      no={no}
      title="What Ares knows"
      note={`${pad(total)} memories`}
      data-testid="what-ares-knows"
    >
      <p className="m-0 border-b border-line2 py-3 pr-6 pl-13 text-note leading-[19px] text-muted">
        What Ares has learned from your answers, your notes and your Sources, each with where it came from.
        Facts he picked up from other people’s content are unconfirmed: he uses them only as background until
        you confirm them.
      </p>
      <div className="flex flex-wrap items-center gap-3 border-b border-line2 py-2.5 pr-6 pl-13">
        <label htmlFor={searchId} className="sr-only">
          Search what Ares knows
        </label>
        <Input
          id={searchId}
          type="search"
          value={query}
          placeholder="Search what Ares knows…"
          className="max-w-[360px]"
          onChange={(event) => setQuery(event.target.value)}
        />
        <form onSubmit={addPreference} className="ml-auto flex items-center gap-2">
          <label htmlFor={preferenceId} className="sr-only">
            A preference for Ares
          </label>
          <Input
            id={preferenceId}
            value={preference}
            placeholder="Tell Ares a preference…"
            className="w-[300px]"
            onChange={(event) => setPreference(event.target.value)}
          />
          <Button size="sm" type="submit" disabled={!preference.trim()}>
            Add preference
          </Button>
        </form>
      </div>
      {forReview.length > 0 && (
        <Group title="For review" note="Their source was deleted: keep them, or delete them">
          {forReview.map((memory) => (
            <MemoryRow
              key={memory.id}
              memory={memory}
              focused={focused === memory.id}
              review
              change={change}
            />
          ))}
        </Group>
      )}
      {known && !total && (
        <p className="hatch m-0 border-b border-line2 py-3 pr-5 pl-13 text-heading text-faint">
          {query.trim()
            ? 'Nothing Ares knows matches that.'
            : 'Nothing yet. Ares learns as you correct him and write.'}
        </p>
      )}
      {KIND_ORDER.map((kind) => {
        const ofKind = memories.filter((memory) => memory.kind === kind);
        if (!ofKind.length) return null;
        return (
          <Group key={kind} title={MEMORY_KIND_NAMES[kind]} note={pad(ofKind.length)}>
            {ofKind.map((memory) => (
              <MemoryRow key={memory.id} memory={memory} focused={focused === memory.id} change={change} />
            ))}
          </Group>
        );
      })}
    </SettingsGroup>
  );
}

function Group({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="m-0 flex items-baseline gap-3 border-b border-line2 bg-raise py-1.5 pr-6 pl-13 text-note font-semibold text-ink">
        {title}
        <span className={metaClass}>{note}</span>
      </h3>
      <ul aria-label={title} className="m-0 list-none p-0">
        {children}
      </ul>
    </div>
  );
}

function SourceLink({ source }: { source: MemorySource }) {
  const openSection = useOpenSection();
  const item = source.item;
  if (!item) return <span className="text-note text-faint">an Item no longer in Commander</span>;
  const gone = goneNote({ ...item });
  const sectionId = sectionFor(item.kind);
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className={metaClass}>{kindTag(item.kind)}</span>
      <button
        type="button"
        className="cursor-pointer border-0 bg-transparent p-0 text-note text-text underline decoration-line underline-offset-2 hover:text-ink disabled:cursor-default disabled:no-underline"
        disabled={!sectionId || item.deletedAt !== null}
        onClick={() => {
          if (!sectionId) return;
          openSection(sectionId);
          requestReveal(sectionId, item.id);
        }}
      >
        {item.title || 'Untitled'}
      </button>
      {gone && <span className="text-note text-faint">({gone})</span>}
    </span>
  );
}

function MemoryRow({
  memory,
  focused,
  review = false,
  change,
}: {
  memory: Memory;
  focused: boolean;
  review?: boolean;
  change: (action: MemoryAction, said?: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [words, setWords] = useState(memory.text);
  const wordsId = useId();
  const rule = memory.kind === 'rule';

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const next = words.trim();
    if (!next || next === memory.text) return setEditing(false);
    if (await change({ type: 'edit', memoryId: memory.id, text: next })) setEditing(false);
  };

  return (
    <li
      data-testid="memory"
      data-memory-id={memory.id}
      aria-current={focused || undefined}
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 border-b border-line2 py-2 pr-6 pl-13',
        focused && 'bg-signal-focus shadow-[inset_3px_0_0_var(--signal)]',
      )}
    >
      <div className="min-w-0">
        {editing ? (
          <form onSubmit={save} className="flex items-center gap-1.5">
            <label htmlFor={wordsId} className="sr-only">
              Words for this memory
            </label>
            <Input
              id={wordsId}
              value={words}
              autoFocus
              onChange={(event) => setWords(event.target.value)}
              onKeyDown={(event) => event.key === 'Escape' && setEditing(false)}
            />
            <Button size="sm" type="submit" variant="primary">
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <div className="flex items-baseline gap-2">
            <span className="text-row leading-[22px] text-ink">{memory.text}</span>
            {!memory.confirmed && <span className={cn(metaClass, 'text-signal-ink')}>Unconfirmed</span>}
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-note text-muted">
          <span className={metaClass}>
            {rule ? 'Rule since' : memory.by === 'user' ? 'Added' : 'Learned'} {learnedOn(memory.learnedAt)}
          </span>
          {rule && <span>Change it in Settings → Rules</span>}
          {memory.sources.length > 0 && (
            <span className="inline-flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              From{' '}
              {memory.sources.slice(0, 5).map((source) => (
                <SourceLink key={source.itemId} source={source} />
              ))}
              {memory.sources.length > 5 && <span>and {memory.sources.length - 5} more</span>}
            </span>
          )}
        </div>
      </div>
      {!rule && !editing && (
        <span className="flex items-center gap-1">
          {review && (
            <Button size="sm" variant="primary" onClick={() => change({ type: 'keep', memoryId: memory.id })}>
              Keep
            </Button>
          )}
          {!memory.confirmed && !review && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => change({ type: 'confirm', memoryId: memory.id })}
            >
              Confirm
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setWords(memory.text);
              setEditing(true);
            }}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => change({ type: 'delete', memoryId: memory.id }, 'Ares forgot it')}
          >
            Delete
          </Button>
        </span>
      )}
    </li>
  );
}
