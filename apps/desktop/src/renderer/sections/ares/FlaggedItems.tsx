import {
  type FlaggedItems as Flagged,
  type FlaggedItem,
  type Item,
  injectionWarningText,
  type SkippedItem,
  UPDATE_SECTION_NAMES,
  type UpdateSection,
} from '@commander/domain';
import { Button, toast } from '@commander/ui';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { requestReveal } from '../../frame/reveal';
import type { ItemStoreClient } from '../../item-store/client';
import { SettingsGroup } from '../../settings/parts';
import { useOpenSection } from '../section';
import { kindTag, sectionFor } from '../todos/links';
import { SOURCE_NAMES } from '../todos/todos';

/*
  Flagged Items (#201): every Item carrying a warning mark, newest first, each with what in it read
  like an instruction (word for word, shown and never sent to a model), its Source and Section, a
  link to open it, and Not an instruction; the marks the User cleared in the last week, with Undo;
  and the Items Ares skipped lately because they hold what looks like one of the User's keys or
  sign-in tokens (never the key itself). Read again whenever Items change.
*/

const pad = (n: number) => String(n).padStart(2, '0');
const metaClass = 'font-mono text-label leading-none font-medium uppercase tracking-label text-muted';
const when = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const report = (error: unknown) => toast(error instanceof Error ? error.message : String(error));

/** Where an Item lives, in words: "Linear · Linear", "Gmail · Email", "Notes". */
function whereOf(item: Item): string {
  const section = sectionFor(item.kind);
  const sectionName = section ? (UPDATE_SECTION_NAMES[section as UpdateSection] ?? section) : null;
  const source = item.source ? SOURCE_NAMES[item.source] : null;
  return [source, sectionName].filter(Boolean).join(' · ');
}

export function FlaggedItems({
  client,
  shown,
  onRefresh,
  no = 'A6',
}: {
  client: ItemStoreClient;
  shown: boolean;
  /** Hears when Items change, so the list is read again. Returns the stop function. */
  onRefresh?: (listener: () => void) => () => void;
  no?: string;
}) {
  const [flagged, setFlagged] = useState<Flagged | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => onRefresh?.(reload), [onRefresh, reload]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload after a change
  useEffect(() => {
    if (!shown) return;
    let current = true;
    client({ op: 'flagged-items' }).then((next) => current && setFlagged(next), report);
    return () => {
      current = false;
    };
  }, [client, shown, version]);

  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      report(error);
    }
    reload();
  };
  const undo = (entryId: number) => act(() => client({ op: 'record', action: { type: 'undo', entryId } }));
  const clear = (item: Item) =>
    act(async () => {
      const entry = await client({ op: 'clear-injection-warning', itemId: item.id });
      toast(`Not an instruction: ${item.title}`, {
        action: { label: 'Undo', onClick: () => void undo(entry.id) },
      });
    });

  const marked = flagged?.marked ?? [];
  const cleared = flagged?.cleared ?? [];
  const skipped = flagged?.skipped ?? [];

  return (
    <SettingsGroup
      no={no}
      title="Flagged Items"
      note={flagged ? `${pad(marked.length)} marked` : undefined}
      data-testid="flagged-items"
    >
      <p className="m-0 border-b border-line2 py-3 pr-6 pl-13 text-note leading-[19px] text-muted">
        Items with text that reads like an instruction to Ares. He ignored it, and nothing he may do changed.
        If it’s ordinary text, choose Not an instruction and the mark goes.
      </p>
      {flagged === null ? (
        <p className="m-0 border-b border-line2 py-3 pr-5 pl-13 text-note text-muted">Loading…</p>
      ) : (
        <>
          {marked.length ? (
            <Rows title="Marked" note={pad(marked.length)}>
              {marked.map((each) => (
                <MarkedRow key={each.item.id} flagged={each} onClear={() => void clear(each.item)} />
              ))}
            </Rows>
          ) : (
            <p className="hatch m-0 border-b border-line2 py-3 pr-5 pl-13 text-heading text-faint">
              Nothing is marked.
            </p>
          )}
          {cleared.length > 0 && (
            <Rows title="Cleared lately" note="Not an instruction, in the last week">
              {cleared.map((each) => (
                <ClearedRow
                  key={each.item.id}
                  flagged={each}
                  onUndo={() => each.clearEntryId !== null && void undo(each.clearEntryId)}
                />
              ))}
            </Rows>
          )}
          {skipped.length > 0 && (
            <Rows title="Skipped for safety" note="Held a key or token: sent to no model">
              {skipped.map((each) => (
                <SkippedRow key={each.entryId} skipped={each} />
              ))}
            </Rows>
          )}
        </>
      )}
    </SettingsGroup>
  );
}

function Rows({ title, note, children }: { title: string; note: string; children: ReactNode }) {
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

/** The Item's title, opening it where it lives. */
function OpenItem({ item }: { item: Item }) {
  const openSection = useOpenSection();
  const sectionId = sectionFor(item.kind);
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5">
      <span className={metaClass}>{kindTag(item.kind)}</span>
      <button
        type="button"
        aria-label={`Open ${item.title || 'Untitled'}`}
        className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-row font-semibold text-ink underline decoration-line underline-offset-2 hover:decoration-ink disabled:cursor-default disabled:no-underline"
        disabled={!sectionId}
        onClick={() => {
          if (!sectionId) return;
          openSection(sectionId);
          requestReveal(sectionId, item.id);
        }}
      >
        {item.title || 'Untitled'}
      </button>
    </span>
  );
}

const rowClass =
  'grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1 border-b border-line2 py-2.5 pr-5 pl-13';

function MarkedRow({ flagged, onClear }: { flagged: FlaggedItem; onClear: () => void }) {
  const { item, quote, at } = flagged;
  return (
    <li data-testid="flagged-item" aria-label={item.title} className={rowClass}>
      <OpenItem item={item} />
      <span className="row-span-3 flex items-start">
        <Button size="sm" aria-label={`Not an instruction: ${item.title}`} onClick={onClear}>
          Not an instruction
        </Button>
      </span>
      <span className={metaClass}>
        {whereOf(item)} · marked <time dateTime={new Date(at).toISOString()}>{when.format(at)}</time>
      </span>
      {quote ? (
        <blockquote
          data-testid="flagged-quote"
          className="m-0 border-l-2 border-signal pl-2 text-note leading-5 text-text"
        >
          “{quote}”
        </blockquote>
      ) : (
        <span className="text-note text-muted">{injectionWarningText(item.kind)}</span>
      )}
    </li>
  );
}

function ClearedRow({ flagged, onUndo }: { flagged: FlaggedItem; onUndo: () => void }) {
  const { item, quote, clearedAt } = flagged;
  return (
    <li data-testid="cleared-item" aria-label={item.title} className={rowClass}>
      <OpenItem item={item} />
      <span className="row-span-3 flex items-start">
        {flagged.clearEntryId !== null && (
          <Button size="sm" aria-label={`Undo Not an instruction: ${item.title}`} onClick={onUndo}>
            Undo
          </Button>
        )}
      </span>
      <span className={metaClass}>
        {whereOf(item)}
        {clearedAt !== null && (
          <>
            {' '}
            · not an instruction, you said{' '}
            <time dateTime={new Date(clearedAt).toISOString()}>{when.format(clearedAt)}</time>
          </>
        )}
      </span>
      {quote && <span className="text-note leading-5 text-muted">“{quote}”</span>}
    </li>
  );
}

function SkippedRow({ skipped }: { skipped: SkippedItem }) {
  const { item, at, why, job } = skipped;
  return (
    <li data-testid="skipped-item" aria-label={item.title} className={rowClass}>
      <OpenItem item={item} />
      <span />
      <span className={metaClass}>
        {whereOf(item)}
        {job && ` · ${job}`} · <time dateTime={new Date(at).toISOString()}>{when.format(at)}</time>
      </span>
      <span className="text-note leading-5 text-text">{why}</span>
    </li>
  );
}
