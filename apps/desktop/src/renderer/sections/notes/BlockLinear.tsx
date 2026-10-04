import './block-linear.css';
import type { Item, LinearIssueDetail } from '@commander/domain';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { requestReveal } from '../../frame/reveal';
import type { ItemChanges } from '../../item-store/changes';
import type { ItemStoreClient } from '../../item-store/client';
import { StateIcon } from '../linear/glyphs';
import { useOpenSection } from '../section';

/*
  Blocks and Linear (Send to Linear, #63): a Block sent to Linear shows its issue as an inline chip
  after its text (identifier and state), which opens the issue in the Linear Section; the issue has a
  made-from Link to the Block. The Block's margin menu (at the end of its row, shown on hover) offers
  Send to Linear…, as does Ctrl+Shift+L in the Block and the palette.
*/

type Issue = Item & { detail: LinearIssueDetail };

/** The live Linear issues sent from each Block on screen, by Block id. */
export const BlockIssuesContext = createContext<ReadonlyMap<string, Issue[]>>(new Map());

/** Reads the issues sent from these Daily Notes' Blocks, again whenever Items change. */
export function useBlockIssues(
  itemStore: ItemStoreClient,
  dailyNoteIds: readonly string[],
  changes?: ItemChanges,
): ReadonlyMap<string, Issue[]> {
  const [issues, setIssues] = useState<ReadonlyMap<string, Issue[]>>(new Map());
  const [version, setVersion] = useState(0);
  const key = dailyNoteIds.join(',');
  useEffect(() => changes?.(() => setVersion((v) => v + 1)), [changes]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the ids, `version` asks again
  useEffect(() => {
    if (!dailyNoteIds.length) {
      setIssues(new Map());
      return;
    }
    let current = true;
    itemStore({ op: 'block-issues', dailyNoteIds: [...dailyNoteIds] }).then(
      (found) => {
        if (!current) return;
        const byBlock = new Map<string, Issue[]>();
        for (const { blockId, issue } of found) {
          if (issue.detail?.kind !== 'linear-issue') continue;
          byBlock.set(blockId, [...(byBlock.get(blockId) ?? []), issue as Issue]);
        }
        setIssues(byBlock);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [itemStore, key, version]);
  return issues;
}

/** The chips for a Block's Linear issues: identifier and state, opening the issue in Linear. */
export function BlockIssueChips({ blockId }: { blockId: string }) {
  const issues = useContext(BlockIssuesContext).get(blockId);
  const openSection = useOpenSection();
  if (!issues?.length) return null;
  return (
    <>
      {issues.map((issue) => {
        const { identifier, state } = issue.detail;
        return (
          <button
            key={issue.id}
            type="button"
            className="n-pill n-issue"
            tabIndex={-1}
            data-testid="block-issue"
            title={`${identifier} · ${issue.title}. Click to open it in the Linear Section.`}
            aria-label={`Open ${identifier} in the Linear Section`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              requestReveal('linear', issue.id);
              openSection('linear');
            }}
          >
            <StateIcon type={state.type} className="n-issue-state" />
            <span>{identifier}</span>
            <span className="n-issue-name">{state.name}</span>
          </button>
        );
      })}
    </>
  );
}

/** The Block's margin menu: Send to Linear…, beside its row. */
export function BlockMenu({ label, onSendToLinear }: { label: string; onSendToLinear: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', onEscape, true);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', onEscape, true);
    };
  }, [open]);
  return (
    <span className="n-menu" ref={ref} data-open={open || undefined}>
      <button
        type="button"
        className="n-menu-button"
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Menu for ${label || 'the Block'}`}
        title="Block menu"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((now) => !now)}
      >
        ⋯
      </button>
      {open && (
        <div role="menu" className="n-menu-list" aria-label="Block menu">
          <button
            type="button"
            role="menuitem"
            className="n-menu-item"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setOpen(false);
              onSendToLinear();
            }}
          >
            Send to Linear… <kbd>Ctrl Shift L</kbd>
          </button>
        </div>
      )}
    </span>
  );
}
