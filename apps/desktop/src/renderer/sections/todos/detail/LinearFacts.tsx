import type { Item } from '@commander/domain';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@commander/ui';
import type { ReactNode } from 'react';
import { StateIcon } from '../../linear/glyphs';
import { goneNote } from '../links';
import { type LinearState, linearIssueOf } from '../todos';

const trigger =
  'h-auto w-auto max-w-full justify-end gap-2 border-0 bg-transparent p-0 text-right hover:border-0 hover:underline hover:decoration-line hover:underline-offset-2 data-[state=open]:underline [&>svg]:size-2.5';

/**
 * A Linear Todo's facts in the detail pane: its issue (opening it in the Linear Section) and the
 * issue's state, which Set Linear state… changes to any state of the issue's team.
 */
export function LinearFacts({
  issue,
  states,
  menuOpen,
  onMenuOpenChange,
  onSetState,
  onOpenIssue,
  Fact,
}: {
  issue: Item;
  /** The states of the issue's team, in its order. */
  states: LinearState[];
  /** Whether Set Linear state…'s menu is open (the palette and `s` open it too). */
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onSetState: (state: LinearState) => void;
  onOpenIssue: () => void;
  Fact: (props: { label: string; children: ReactNode }) => ReactNode;
}) {
  const linear = linearIssueOf(issue);
  if (!linear) return null;
  const { identifier, state } = linear.detail;
  const gone = goneNote(issue);
  return (
    <>
      <Fact label="Linear">
        {gone ? (
          <span className="text-faint">
            {identifier} · {gone}
          </span>
        ) : (
          <button
            type="button"
            aria-label={`Open ${identifier} in the Linear Section`}
            onClick={onOpenIssue}
            className="cursor-pointer border-0 bg-transparent p-0 font-[inherit] tracking-[inherit] text-ink uppercase hover:underline hover:decoration-line hover:underline-offset-2"
          >
            {identifier}
          </button>
        )}
      </Fact>
      <Fact label="Linear state">
        {gone ? (
          state.name
        ) : (
          <Select
            value={state.id}
            open={menuOpen}
            onOpenChange={onMenuOpenChange}
            onValueChange={(id) => {
              const chosen = states.find((each) => each.id === id);
              if (chosen && chosen.id !== state.id) onSetState(chosen);
            }}
          >
            <SelectTrigger aria-label="Set Linear state…" title="Set Linear state… (S)" className={trigger}>
              <SelectValue>
                <span className="flex items-center gap-2">
                  <span aria-hidden="true" className="flex">
                    <StateIcon type={state.type} />
                  </span>
                  {state.name}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent
              align="end"
              onCloseAutoFocus={(event) => {
                // So the Section's keys (x, Ctrl+Z, Esc) work straight after a choice.
                event.preventDefault();
              }}
            >
              {states.map((each) => (
                <SelectItem key={each.id} value={each.id}>
                  <span className="flex items-center gap-2">
                    <span aria-hidden="true" className="flex">
                      <StateIcon type={each.type} />
                    </span>
                    {each.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Fact>
    </>
  );
}
