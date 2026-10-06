import type { PersonCard as Card, PersonWork } from '@commander/domain';
import { AresText, cn } from '@commander/ui';
import { type ReactNode, useState } from 'react';
import { daysText, stuckText, writtenBy } from './people';

const pad = (n: number) => String(n).padStart(2, '0');

/** What a card's rows open: a pull request (in the GitHub Section) or a Linear issue (in Linear). */
export type CardTarget = { itemId: string; kind: 'pull-request' | 'linear-issue' };

/** Where Ares's paragraph on a card stands: Refresh offered, writing, or why it couldn't. */
export type ParagraphState = { refreshing: boolean; problem: string | null };

/**
 * One Person's week, after the prototype's Section rows and the Project page's count strip: their
 * name (opening their page) and handles, plain marks for what is worth a look, then Merged and
 * Reviewed (counts that expand to their pull requests), their open pull requests with how long each
 * has been open and why it is stuck, the reviews waiting on them with how long each has waited, and
 * their open Linear issues. Below, Ares's paragraph (AresText) with when he wrote it and Refresh;
 * with none yet (or the model off), the card shows its facts alone. Nothing here scores or ranks.
 */
export function PersonCard({
  card,
  now,
  onOpen,
  onOpenPerson,
  onRefresh,
  paragraphState,
  sourcesOf,
  expanded = false,
}: {
  card: Card;
  now: number;
  onOpen: (target: CardTarget) => void;
  /** Opens their page; left out on the page itself. */
  onOpenPerson?: (personId: string) => void;
  /** Refresh their paragraph; left out when Ares can't write (the model off). */
  onRefresh?: () => void;
  paragraphState?: ParagraphState;
  /** What the paragraph may link to (AresText): what its Items say. */
  sourcesOf?: (itemIds: readonly string[]) => string[];
  /** Merged and Reviewed shown open (a Person's page). */
  expanded?: boolean;
}) {
  const [shown, setShown] = useState({ merged: expanded, reviewed: expanded });
  const isOpen = (which: 'merged' | 'reviewed') => shown[which] && card[which].length > 0;
  const toggle = (which: 'merged' | 'reviewed') => setShown((was) => ({ ...was, [which]: !was[which] }));
  const pull = (itemId: string) => onOpen({ itemId, kind: 'pull-request' });
  const handles = card.logins.map((login) => `@${login}`).join(' · ');

  return (
    <article aria-label={card.name} data-testid="person-card" className="border-b border-line bg-sheet">
      <header className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1.5 py-2 pr-5 pl-[41px]">
        {onOpenPerson && card.personId ? (
          <button
            type="button"
            data-testid="person-card-name"
            onClick={() => onOpenPerson(card.personId as string)}
            title={`Open ${card.name}’s page`}
            className="cursor-pointer border-0 bg-transparent p-0 text-left font-sans text-[15px] leading-tight font-bold text-ink font-stretch-(--stretch-wide) hover:underline"
          >
            {card.name}
          </button>
        ) : (
          <h3
            data-testid="person-card-name"
            className="m-0 font-sans text-[15px] leading-tight font-bold text-ink font-stretch-(--stretch-wide)"
          >
            {card.name}
          </h3>
        )}
        {handles && <span className="font-mono text-label leading-none text-faint">{handles}</span>}
        <span className="flex-1" />
        {card.marks.map((mark) => (
          <span
            key={mark}
            data-testid="person-mark"
            className="border border-ink px-1.5 py-[3px] font-mono text-label leading-none font-semibold uppercase tracking-label whitespace-nowrap text-ink"
          >
            {mark}
          </span>
        ))}
      </header>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and form semantics */}
      <div
        role="group"
        aria-label={`${card.name}’s counts`}
        className="ml-[41px] grid grid-cols-5 border-t border-l border-line2"
      >
        <Count
          label="Merged"
          count={card.merged.length}
          open={isOpen('merged')}
          onToggle={() => toggle('merged')}
        />
        <Count
          label="Reviewed"
          count={card.reviewed.length}
          open={isOpen('reviewed')}
          onToggle={() => toggle('reviewed')}
        />
        <Count label="Open PRs" count={card.open.length} />
        <Count label="Reviews waiting" count={card.waiting.length} />
        <Count label="Linear" count={card.linear.length} />
      </div>
      <div className="grid gap-x-6 py-1.5 pr-5 pl-[41px]">
        {isOpen('merged') && (
          <Part title="Merged" testId="person-merged">
            {card.merged.map((work) => (
              <WorkLine key={work.itemId} work={work} onOpen={() => pull(work.itemId)} />
            ))}
          </Part>
        )}
        {isOpen('reviewed') && (
          <Part title="Reviewed" testId="person-reviewed">
            {card.reviewed.map((work) => (
              <WorkLine key={work.itemId} work={work} onOpen={() => pull(work.itemId)} />
            ))}
          </Part>
        )}
        {card.open.length > 0 && (
          <Part title="Open pull requests" testId="person-open">
            {card.open.map((work) => (
              <WorkLine
                key={work.itemId}
                work={work}
                onOpen={() => pull(work.itemId)}
                meta={`${work.draft ? 'draft · ' : ''}${work.openDays ? `open ${daysText(work.openDays)}` : 'opened today'}`}
                note={work.stuck.length ? `Stuck: ${work.stuck.map(stuckText).join(', ')}` : undefined}
              />
            ))}
          </Part>
        )}
        {card.waiting.length > 0 && (
          <Part title="Reviews waiting on them" testId="person-waiting">
            {card.waiting.map((work) => (
              <WorkLine
                key={work.itemId}
                work={work}
                onOpen={() => pull(work.itemId)}
                meta={work.waitDays ? `waiting ${daysText(work.waitDays)}` : 'asked today'}
                note={work.author ? `by ${work.author}` : undefined}
              />
            ))}
          </Part>
        )}
        {card.linear.length > 0 && (
          <Part title="Linear issues" testId="person-linear">
            {card.linear.map((issue) => (
              <WorkLine
                key={issue.itemId}
                work={issue}
                onOpen={() => onOpen({ itemId: issue.itemId, kind: 'linear-issue' })}
                meta={issue.state}
              />
            ))}
          </Part>
        )}
      </div>
      <Paragraph card={card} now={now} onRefresh={onRefresh} state={paragraphState} sourcesOf={sourcesOf} />
    </article>
  );
}

function Count({
  label,
  count,
  open,
  onToggle,
}: {
  label: string;
  count: number;
  open?: boolean;
  onToggle?: () => void;
}) {
  const body = (
    <>
      <span className="font-mono text-tiny leading-none font-medium uppercase tracking-caps whitespace-nowrap text-muted">
        {label}
      </span>
      <span
        className={cn(
          'font-sans text-[18px] leading-none tabular-nums font-stretch-[112%]',
          count ? 'font-bold text-ink' : 'font-normal text-faint',
        )}
      >
        {pad(count)}
      </span>
    </>
  );
  const cell =
    'flex min-w-0 flex-col items-start justify-center gap-[5px] border-r border-b border-line2 px-3 py-2';
  if (!onToggle || !count)
    return (
      // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and form semantics
      <div role="group" className={cell} data-testid="person-count" aria-label={`${label}: ${count}`}>
        {body}
      </div>
    );
  return (
    <button
      type="button"
      data-testid="person-count"
      aria-expanded={open}
      aria-label={`${label}: ${count}`}
      onClick={onToggle}
      className={cn(cell, 'cursor-pointer bg-transparent text-left hover:bg-raise', open && 'bg-raise')}
    >
      {body}
    </button>
  );
}

function Part({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section aria-label={title} data-testid={testId} className="py-1">
      <h4 className="m-0 font-mono text-label leading-6 font-semibold uppercase tracking-label text-muted">
        {title}
      </h4>
      <ul className="m-0 list-none p-0">{children}</ul>
    </section>
  );
}

function WorkLine({
  work,
  onOpen,
  meta,
  note,
}: {
  work: Pick<PersonWork, 'itemId' | 'identifier' | 'title'>;
  onOpen: () => void;
  meta?: string;
  note?: string;
}) {
  return (
    <li className="flex items-baseline gap-3 text-note leading-5" data-testid="person-work">
      <button
        type="button"
        onClick={onOpen}
        title={`Open ${work.identifier}`}
        className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-2.5 border-0 bg-transparent p-0 text-left text-text hover:text-ink"
      >
        <span className="flex-none font-mono text-label text-muted">{work.identifier}</span>
        <span className="min-w-0 truncate hover:underline">{work.title}</span>
      </button>
      {note && <span className="min-w-0 flex-none truncate text-muted">{note}</span>}
      {meta && (
        <span className="flex-none font-mono text-label leading-5 uppercase tracking-label text-faint">
          {meta}
        </span>
      )}
    </li>
  );
}

// Ares's paragraph about their week (#122): his words through AresText, when he wrote them, and
// Refresh. Nothing at all when there is none and he can't write one.
function Paragraph({
  card,
  now,
  onRefresh,
  state,
  sourcesOf,
}: {
  card: Card;
  now: number;
  onRefresh?: () => void;
  state?: ParagraphState;
  sourcesOf?: (itemIds: readonly string[]) => string[];
}) {
  const { paragraph } = card;
  if (!paragraph && !onRefresh && !state?.problem) return null;
  return (
    <div
      data-testid="person-paragraph"
      className={cn(
        'mb-3 ml-[41px] mr-5 flex items-baseline gap-2.5 border px-2.5 py-1.5 text-note leading-[1.4] text-text',
        // His words stand out; the wait for them doesn't.
        paragraph ? 'border-signal bg-signal-soft' : 'border-dashed border-line2',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex-none px-1 font-mono text-[9px] font-bold uppercase',
          paragraph ? 'bg-signal text-on-signal' : 'border border-line2 text-muted',
        )}
      >
        Ares
      </span>
      <div className="min-w-0 flex-1">
        {paragraph ? (
          <>
            <p className="m-0" data-testid="person-paragraph-text">
              <AresText inline text={paragraph.text} sources={sourcesOf?.(paragraph.itemIds) ?? []} />
            </p>
            <p
              data-testid="person-paragraph-by"
              className="m-0 font-mono text-label leading-5 uppercase tracking-label text-muted"
            >
              {writtenBy(paragraph, now)}
            </p>
          </>
        ) : (
          <p className="m-0 text-muted">
            No paragraph from Ares yet: he writes one with each morning’s summary.
          </p>
        )}
        {state?.problem && (
          <p role="status" data-testid="person-paragraph-problem" className="m-0 text-muted">
            {state.problem}
          </p>
        )}
      </div>
      {onRefresh && (
        <button
          type="button"
          data-testid="person-paragraph-refresh"
          disabled={state?.refreshing}
          onClick={onRefresh}
          aria-label={`Refresh Ares’s paragraph about ${card.name}`}
          className="flex-none cursor-pointer border-0 bg-transparent p-0 font-mono text-label leading-none font-medium uppercase tracking-label whitespace-nowrap text-ink hover:underline disabled:cursor-default disabled:text-faint"
        >
          {state?.refreshing ? 'Ares is writing…' : 'Refresh'}
        </button>
      )}
    </div>
  );
}
