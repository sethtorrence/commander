import { AresText, Button, ButtonGroup } from '@commander/ui';
import { useCommands } from '../../palette/commands';
import { SideCard } from '../../projects/page/SideCard';
import { clock, dayKey, longDay } from './agenda';
import type { FocusBlock, FocusTime } from './focus-time';
import { wallMinutes } from './time-grid';

/*
  Focus time in the Calendar Section (#131): the panel in the side column, with Plan focus time (in the
  palette too), Ares's focus block suggestions (each with Accept and Dismiss, and Accept all) and the
  blocks accepted (each with Undo); and the suggestions dashed in the views: blocks in Day and Week,
  rows in the Agenda, on their days.
  Ares's words show as plain text (AresText).
*/

const pad = (n: number) => String(n).padStart(2, '0');
const span = (block: FocusBlock, timeZone: string) =>
  `${clock(block.start, timeZone)}–${clock(block.end, timeZone)}`;
const when = (block: FocusBlock, timeZone: string) =>
  `${longDay(dayKey(block.start, timeZone))} · ${span(block, timeZone)}`;

function Suggestion({ block, focus, timeZone }: { block: FocusBlock; focus: FocusTime; timeZone: string }) {
  return (
    <li
      aria-label={`Focus block: ${block.title}`}
      data-testid="focus-suggestion"
      className="m-2 border border-dashed border-ink/50 px-2.5 py-2"
    >
      <p className="m-0 font-mono text-label leading-tight uppercase tracking-label text-muted">
        {when(block, timeZone)}
      </p>
      <p className="m-0 mt-1 font-semibold text-ink">{block.title}</p>
      <p className="m-0 mt-1 text-muted">
        <AresText inline text={block.reason} sources={[block.todoTitle]} />
      </p>
      <div className="mt-2 flex gap-1.5">
        <Button size="sm" variant="signal" onClick={() => void focus.accept(block.id)}>
          Accept
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void focus.dismiss(block.id)}>
          Dismiss
        </Button>
      </div>
    </li>
  );
}

/** The Focus time card in the Calendar Section's side column. */
export function FocusTimePanel({ focus, timeZone }: { focus: FocusTime; timeZone: string }) {
  useCommands([{ label: 'Plan focus time', run: () => void focus.plan() }]);
  const { suggestions, planned } = focus;
  return (
    <SideCard label="Focus time" title="Focus time" note={pad(suggestions.length)}>
      <div className="flex flex-wrap gap-1.5 border-b border-line2 px-2.5 py-2">
        <ButtonGroup>
          <Button size="sm" onClick={() => void focus.plan()}>
            Plan focus time
          </Button>
          {suggestions.length > 1 && (
            <Button size="sm" onClick={() => void focus.acceptAll()}>
              Accept all
            </Button>
          )}
        </ButtonGroup>
      </div>
      {suggestions.length ? (
        <ul className="m-0 list-none p-0" aria-label="Suggested focus blocks">
          {suggestions.map((block) => (
            <Suggestion key={block.id} block={block} focus={focus} timeZone={timeZone} />
          ))}
        </ul>
      ) : (
        <p className="m-0 px-2.5 py-2 text-note text-faint">
          Each working morning Ares suggests focus blocks for your Todos in your free time. Plan focus time
          asks him now.
        </p>
      )}
      {planned.length > 0 && (
        <>
          <p className="m-0 border-t border-line2 px-2.5 pt-2 font-mono text-label leading-tight uppercase tracking-label text-muted">
            Planned
          </p>
          <ul className="m-0 list-none p-0" aria-label="Planned focus blocks">
            {planned.map((block) => (
              <li
                key={block.id}
                aria-label={`Planned: ${block.title}`}
                className="flex items-center gap-2 border-b border-line2 px-2.5 py-1.5 last:border-b-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ink">{block.title}</span>
                  <span className="block font-mono text-label uppercase tracking-label text-muted">
                    {when(block, timeZone)}
                  </span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => void focus.undo(block.id)}>
                  Undo
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </SideCard>
  );
}

/** A day's focus block suggestions, as dashed rows among its events in the Agenda. */
export function FocusSuggestionRows({
  blocks,
  focus,
  timeZone,
}: {
  blocks: readonly FocusBlock[] | undefined;
  focus: FocusTime;
  timeZone: string;
}) {
  if (!blocks?.length) return null;
  return (
    <ul className="m-0 list-none p-0" aria-label="Suggested focus blocks this day">
      {blocks.map((block) => (
        <li
          key={block.id}
          data-testid="focus-suggestion-row"
          aria-label={`Suggested ${span(block, timeZone)} ${block.title}`}
          className="relative flex min-h-10 items-center border-b border-dashed border-line py-[5px] pr-5 pl-13 text-muted"
        >
          <span className="w-[92px] flex-none font-mono text-code-lg leading-[30px] tracking-mono whitespace-nowrap tabular-nums">
            {span(block, timeZone)}
          </span>
          <span className="ml-[57px] min-w-0 flex-1 truncate border border-dashed border-ink/40 px-2 text-row leading-[26px]">
            {block.title}
            <span className="ml-2 font-mono text-label uppercase tracking-label">Suggested by Ares</span>
          </span>
          <span className="ml-3 flex flex-none gap-1.5">
            <Button
              size="sm"
              variant="signal"
              onClick={() => void focus.accept(block.id)}
              aria-label={`Accept ${block.title}`}
            >
              Accept
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void focus.dismiss(block.id)}
              aria-label={`Dismiss ${block.title}`}
            >
              Dismiss
            </Button>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A day's focus block suggestions, as dashed blocks in its column of the Day and Week views. */
export function FocusSuggestionBlocks({
  blocks,
  focus,
  timeZone,
  top,
}: {
  blocks: readonly FocusBlock[] | undefined;
  focus: FocusTime;
  timeZone: string;
  /** Minutes from midnight → px down the column. */
  top: (minutes: number) => number;
}) {
  if (!blocks?.length) return null;
  return (
    <ul className="m-0 list-none p-0" aria-label="Suggested focus blocks">
      {blocks.map((block) => {
        const start = wallMinutes(block.start, timeZone);
        const end = Math.max(start + 15, wallMinutes(block.end, timeZone) || 24 * 60);
        return (
          <li
            key={block.id}
            data-testid="focus-suggestion-block"
            aria-label={`Suggested ${span(block, timeZone)} ${block.title}`}
            title={block.reason}
            className="absolute right-0.5 left-0.5 z-2 flex flex-col gap-0.5 overflow-hidden border border-dashed border-ink/60 bg-sheet px-1.5 py-1"
            style={{ top: top(start), height: Math.max(top(end) - top(start) - 1, 14) }}
          >
            <span className="truncate font-mono text-label leading-none text-muted">
              {span(block, timeZone)} · Suggested
            </span>
            <span className="truncate text-note leading-[16px] font-semibold text-ink">{block.title}</span>
            <span className="flex gap-1">
              <Button
                size="sm"
                variant="signal"
                onClick={() => void focus.accept(block.id)}
                aria-label={`Accept ${block.title}`}
              >
                Accept
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void focus.dismiss(block.id)}
                aria-label={`Dismiss ${block.title}`}
              >
                Dismiss
              </Button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
