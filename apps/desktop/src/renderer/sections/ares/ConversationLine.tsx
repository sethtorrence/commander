import type {
  ConversationAboutLine,
  ConversationMade,
  ConversationTurn,
  RowAction,
  UpdateViewLine,
} from '@commander/domain';
import { AresText, Button, ButtonGroup, cn, Kbd, toast } from '@commander/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type UpdatesApi, useUpdates } from '../../updates/context';
import { lineStatus, openTarget } from '../../updates/updates';
import type { ConversationsClient } from './conversations';
import type { CoreMessages } from './use-conversations';

/*
  A Conversation about an Update line (#236), wherever its thread is drawn (ConversationThread: the
  Ares panel, the Ares Section and the pop-up): the line it is about, under its title, as the line
  stands now (still waiting, snoozed, done, dismissed, settled elsewhere or expired: the Conversation
  stays and says so), with a link back to the Update it was replied to in. Under Ares's answers, the line's own actions he prepared, each a card the User confirms with one key: Confirm
  does exactly what the line's button does (the Update's own actions, opening an editor or the composer
  where the button does), then the card says so; Not now (or Escape) declines it. A line no longer
  waiting offers nothing, so its cards only say what became of it.
*/

type LineAction = Extract<ConversationMade, { kind: 'line-action' }>;

/** The line as it stands now, read from its Update, again whenever the queue changes. */
function useUpdateLine(about: ConversationAboutLine, onCoreMessage: CoreMessages) {
  const { past } = useUpdates();
  const [line, setLine] = useState<UpdateViewLine | null | undefined>(undefined);
  const { updateId, queuedId } = about;
  const reload = useCallback(
    () =>
      past(updateId).then(
        (view) => setLine(view.lines.find((each) => each.queuedId === queuedId) ?? null),
        () => setLine(null),
      ),
    [past, updateId, queuedId],
  );
  useEffect(() => {
    void reload();
    return onCoreMessage((message) => {
      if (message.type === 'ares-updates' || message.type === 'core-restarted') void reload();
    });
  }, [reload, onCoreMessage]);
  return { line, reload };
}

/** Where the line stands, as the Conversation says it. */
export function lineStanding(line: UpdateViewLine | null, now: number): string {
  const queued = line?.queued;
  if (!line || !queued) return 'No longer in Commander';
  switch (queued.status) {
    case 'done':
      return 'You marked it done';
    case 'dismissed':
      return 'You dismissed it';
    case 'resolved':
      return 'Settled elsewhere';
    case 'expired':
      return 'Expired: no longer needed';
    default:
      return lineStatus(line, now) ?? 'Waiting in your Update';
  }
}

const metaClass = 'font-mono text-label leading-5 font-semibold uppercase tracking-label text-muted';

/** The line a Conversation is about, under its title, with the way back to its Update. */
export function AboutLine({
  about,
  onCoreMessage,
  compact = false,
}: {
  about: ConversationAboutLine;
  onCoreMessage: CoreMessages;
  // In the pop-up and the panel: narrower padding.
  compact?: boolean;
}) {
  const { reopen } = useUpdates();
  const { line } = useUpdateLine(about, onCoreMessage);
  if (line === undefined) return null;
  const waiting = line?.queued?.status === 'queued';
  return (
    <div
      data-testid="conversation-about-line"
      className={cn(
        'grid flex-none grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 border-b border-line2 py-2',
        compact ? 'px-3' : 'px-5',
        waiting && 'shadow-[inset_3px_0_0_var(--signal)]',
      )}
    >
      <div className={cn(metaClass, 'flex items-center gap-2')}>
        About a line of your Update
        <span
          data-testid="conversation-about-line-status"
          className={cn('border px-[7px]', waiting ? 'border-signal text-signal-ink' : 'border-line')}
        >
          {lineStanding(line, Date.now())}
        </span>
      </div>
      <Button size="sm" variant="ghost" className="row-span-2" onClick={() => reopen(about.updateId)}>
        Open the Update
      </Button>
      {line && (
        <p className="m-0 min-w-0 text-note leading-5 text-text">
          <AresText inline text={line.text} sources={line.sources} />
        </p>
      )}
    </div>
  );
}

/**
 * The line's actions Ares prepared in one of his answers, as cards. `focus`: the answer just arrived
 * and the User isn't writing, so the first card waiting takes the focus (Enter confirms it).
 */
export function LineActionCards({
  turn,
  about,
  client,
  onCoreMessage,
  focus,
  onSettled,
}: {
  turn: ConversationTurn;
  about: ConversationAboutLine;
  client: ConversationsClient;
  onCoreMessage: CoreMessages;
  focus: boolean;
  onSettled?: () => void;
}) {
  const updates = useUpdates();
  const { line, reload } = useUpdateLine(about, onCoreMessage);
  const cards = turn.made.flatMap((made, index) => (made.kind === 'line-action' ? [{ made, index }] : []));
  if (!cards.length || line === undefined) return null;
  const answered = turn.status !== 'queued' && turn.status !== 'streaming';
  const lineWaiting = line?.queued?.status === 'queued';
  const firstWaiting = cards.find(({ made }) => made.status === 'waiting')?.index;

  const settle = async (index: number, status: 'confirmed' | 'declined') => {
    await client({
      op: 'settle-line-action',
      conversationId: turn.conversationId,
      turnId: turn.id,
      index,
      status,
    });
  };
  const confirm = async (made: LineAction, index: number) => {
    try {
      await carryOut(made, updates);
      await settle(index, 'confirmed');
    } catch (error) {
      report(error);
    }
    await reload();
    onSettled?.();
  };
  const decline = async (index: number) => {
    await settle(index, 'declined').catch(report);
    onSettled?.();
  };

  return (
    <ul aria-label="The line’s actions" className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
      {cards.map(({ made, index }) => (
        <LineActionCard
          key={index}
          made={made}
          ready={answered && lineWaiting}
          moot={!lineWaiting ? lineStanding(line, Date.now()) : null}
          focus={focus && answered && index === firstWaiting}
          onConfirm={() => void confirm(made, index)}
          onDecline={() => void decline(index)}
        />
      ))}
    </ul>
  );
}

/** Carries a line action out exactly as the line's own button (or its Item's) does in the Update. */
async function carryOut(made: LineAction, updates: UpdatesApi): Promise<void> {
  const view = await updates.past(made.updateId);
  const line = view.lines.find((each) => each.queuedId === made.queuedId);
  if (!line) throw new Error('That Update line is no longer in Commander');
  if (made.itemId === null) {
    if (made.action === 'open') return updates.open(openTarget(line));
    if (
      made.action === 'reply' ||
      made.action === 'edit' ||
      made.action === 'tick' ||
      made.action === 'not-an-instruction'
    )
      throw new Error('That isn’t one of the line’s own actions');
    return updates.act(line, made.action, made.snooze ?? undefined);
  }
  const row = line.rows.find((each) => each.itemId === made.itemId);
  if (!row || row.settled || !row.actions.includes(made.action as (typeof row.actions)[number])) {
    throw new Error('The line doesn’t offer that on this Item any more');
  }
  if (made.action === 'open' || made.action === 'reply' || made.action === 'edit') {
    return updates.open(
      openTarget(line, row, { reply: made.action === 'reply', edit: made.action === 'edit' }),
    );
  }
  return updates.actRow(line, row, made.action as RowAction);
}

const STATUS_TEXT: Record<LineAction['status'], string> = {
  waiting: 'Waiting for you',
  confirmed: 'Confirmed by you',
  declined: 'Not now',
};

function LineActionCard({
  made,
  ready,
  moot,
  focus,
  onConfirm,
  onDecline,
}: {
  made: LineAction;
  // It can be confirmed now: his answer is finished and the line still waits.
  ready: boolean;
  // What became of the line, once it no longer waits.
  moot: string | null;
  focus: boolean;
  onConfirm: () => void;
  onDecline: () => void;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);
  const waiting = made.status === 'waiting';
  const open = waiting && ready;

  // One key: the card waiting takes the focus once, so Enter confirms it.
  useEffect(() => {
    if (!focus || !open || focused.current) return;
    focused.current = true;
    confirm.current?.focus();
  }, [focus, open]);

  const status = waiting && moot ? `The line: ${moot}` : STATUS_TEXT[made.status];
  return (
    <li
      data-testid="conversation-line-action"
      data-status={waiting && moot ? 'moot' : made.status}
      aria-label={`Act on the Update line: ${made.what}`}
      onKeyDown={(event) => {
        if (open && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onDecline();
        }
      }}
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 border border-line2 bg-sheet px-3 py-2',
        open && 'border-signal shadow-[inset_3px_0_0_var(--signal)]',
      )}
    >
      <div className={cn(metaClass, 'flex min-w-0 flex-wrap items-center gap-2')}>
        <span className="text-ink">The Update line</span>
        <span
          data-testid="conversation-line-action-status"
          className={cn('border px-[7px]', open ? 'border-signal text-signal-ink' : 'border-line')}
        >
          {status}
        </span>
      </div>
      <div className="row-span-2 flex items-start">
        {open && (
          <ButtonGroup>
            <Button ref={confirm} variant="signal" onClick={onConfirm}>
              Confirm <Kbd>↵</Kbd>
            </Button>
            <Button onClick={onDecline}>Not now</Button>
          </ButtonGroup>
        )}
      </div>
      <p className="m-0 min-w-0 text-row leading-6 font-semibold text-ink">{made.what}</p>
    </li>
  );
}

const report = (error: unknown) => toast(error instanceof Error ? error.message : String(error));
