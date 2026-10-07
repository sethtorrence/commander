import { ACTION_KIND_NAMES, type AresActivity, type ConversationTurn } from '@commander/domain';
import { AresText, Button, ButtonGroup, cn, Kbd, toast } from '@commander/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useProjectsIfAny } from '../../projects/context';
import { type AutonomyClient, describeItemActions } from './activity';
import { actionStatus } from './conversations';
import type { CoreMessages } from './use-conversations';

/*
  What Ares did or prepared in one of his answers (#196): a card for each action his Skills handed the
  gate, under his words, read from Ares's activity as it stands now (accepted, dismissed or undone
  anywhere shows here too).

  - Waiting for the User (Ask: Act for you, anything chained, or what the settings hold at Ask): the
    card says exactly what will happen, and what caused it when it follows from outside content.
    Confirm, with one key: when the answer arrives and the User isn't writing, Confirm takes the
    focus, so Enter confirms it (Escape dismisses it). Nothing more happens by itself.
  - Done by Ares (what the settings let run): what he did, with Undo.
  - Confirmed, dismissed or undone: says so.
  - A change to his own settings (#197) always waits for the User: the card shows the setting, its
    value now and the new one, and once confirmed, Undo puts the old value back.
*/

/**
 * The cards under one of Ares's answers, if it took or prepared any actions, kept in step with his
 * activity through the Core's messages: in the Ares Section and the Ares button's pop-up alike.
 */
export function AnswerActions({
  turn,
  client,
  onCoreMessage,
  last,
  writing,
  onSettled,
}: {
  turn: ConversationTurn;
  client: AutonomyClient | undefined;
  onCoreMessage: CoreMessages;
  // The answer is the Conversation's latest, and whether the User is writing a message now.
  last: boolean;
  writing: boolean;
  onSettled?: () => void;
}) {
  const onAresActivity = useCallback(
    (listener: () => void) =>
      onCoreMessage((message) => {
        if (message.type === 'ares-activity') listener();
      }),
    [onCoreMessage],
  );
  if (!client || !turn.proposalIds.length) return null;
  return (
    <ConversationActions
      proposalIds={turn.proposalIds}
      client={client}
      onAresActivity={onAresActivity}
      focusWaiting={last && turn.status === 'done' && !writing}
      onSettled={onSettled}
    />
  );
}

const metaClass = 'font-mono text-label leading-5 font-semibold uppercase tracking-label text-muted';

export function ConversationActions({
  proposalIds,
  client,
  onAresActivity,
  focusWaiting = false,
  onSettled,
}: {
  proposalIds: readonly number[];
  client: AutonomyClient;
  // Hears that Ares's activity changed, to read the cards again.
  onAresActivity?: (listener: () => void) => () => void;
  // Give the first card waiting for the User the focus (the answer just arrived and nothing is typed).
  focusWaiting?: boolean;
  // A card was confirmed or dismissed here: the composer takes the focus back.
  onSettled?: () => void;
}) {
  const [rows, setRows] = useState<AresActivity[] | null>(null);
  const [version, setVersion] = useState(0);
  const key = proposalIds.join(',');
  const changed = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => onAresActivity?.(changed), [onAresActivity, changed]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload after a change
  useEffect(() => {
    if (!key) return;
    let current = true;
    const ids = key.split(',').map(Number);
    client({ op: 'activity', query: { ids } }).then(
      // In the order he took them.
      (next) => current && setRows(ids.flatMap((id) => next.filter((row) => row.id === id))),
      (error: unknown) => current && report(error),
    );
    return () => {
      current = false;
    };
  }, [client, key, version]);

  const run = async (work: () => Promise<unknown>, settled = false) => {
    try {
      await work();
    } catch (error) {
      report(error);
    }
    changed();
    if (settled) onSettled?.();
  };

  if (!rows?.length) return null;
  const firstWaiting = rows.find((row) => row.status === 'pending')?.id;
  return (
    <ul aria-label="What Ares did" className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
      {rows.map((row) => (
        <ActionCard
          key={row.id}
          row={row}
          focus={focusWaiting && row.id === firstWaiting}
          onConfirm={() => run(() => client({ op: 'accept', proposalId: row.id }), true)}
          onDismiss={() => run(() => client({ op: 'dismiss', proposalId: row.id }), true)}
          onUndo={() => run(() => client({ op: 'undo', proposalId: row.id }))}
        />
      ))}
    </ul>
  );
}

function ActionCard({
  row,
  focus,
  onConfirm,
  onDismiss,
  onUndo,
}: {
  row: AresActivity;
  focus: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
  onUndo: () => void;
}) {
  const projects = useProjectsIfAny();
  const projectName = (projectId: string) => {
    const project = projects?.projectById(projectId);
    return project && `${project.code} · ${project.name}`;
  };
  const confirm = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);
  const waiting = row.status === 'pending';
  const status = actionStatus(row);

  // One key: the card waiting takes the focus once, so Enter confirms it.
  useEffect(() => {
    if (!focus || !waiting || focused.current) return;
    focused.current = true;
    confirm.current?.focus();
  }, [focus, waiting]);

  const lines = [...new Set(describeItemActions(row.itemActions, projectName))];
  const setting = row.itemActions.find((action) => action.type === 'change-setting');
  // What Ares wrote may link only to what the Items it was about say (AresText).
  const sources = [row.item?.title ?? '', row.cause?.item?.title ?? ''];
  // The Item it is on, unless it only sits on today's Daily Note (a new Todo made from nothing).
  const on = row.item && row.item.kind !== 'daily-note' ? row.item : null;
  const cause = row.chained ? row.cause?.item : null;
  return (
    <li
      data-testid="conversation-action"
      data-status={status.key}
      aria-label={`${row.name}: ${lines[0] ?? 'an action'}`}
      onKeyDown={(event) => {
        if (waiting && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
        }
      }}
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 border border-line2 bg-sheet px-3 py-2',
        waiting && 'border-signal shadow-[inset_3px_0_0_var(--signal)]',
      )}
    >
      <div className={cn(metaClass, 'flex min-w-0 flex-wrap items-center gap-2')}>
        <span className="text-ink">{row.name}</span>
        <span>{ACTION_KIND_NAMES[row.actionKind]}</span>
        <span
          data-testid="conversation-action-status"
          className={cn('border px-[7px]', waiting ? 'border-signal text-signal-ink' : 'border-line')}
        >
          {status.text}
        </span>
      </div>
      <div className="row-span-3 flex items-start">
        {waiting ? (
          <ButtonGroup>
            <Button ref={confirm} variant="signal" onClick={onConfirm}>
              Confirm <Kbd>↵</Kbd>
            </Button>
            <Button onClick={onDismiss}>Dismiss</Button>
          </ButtonGroup>
        ) : (
          row.undoable && <Button onClick={onUndo}>Undo</Button>
        )}
      </div>
      <div className="min-w-0">
        {setting?.type === 'change-setting' ? (
          <SettingChange name={setting.name} from={setting.fromWords} to={setting.toWords} />
        ) : (
          lines.map((line) => (
            <p key={line} className="m-0 text-row leading-6 font-semibold text-ink">
              <AresText inline text={line} sources={sources} />
            </p>
          ))
        )}
        {on && !setting && (
          <p className="m-0 text-note leading-5 text-muted">
            On <span className="text-text">{on.title}</span>
          </p>
        )}
      </div>
      {waiting && (row.chained || row.actionKind === 'act-for-you' || setting) && (
        <p className="m-0 min-w-0 text-note leading-5 text-muted" data-testid="conversation-action-why">
          {setting
            ? 'Asks first: Ares never changes his own settings without you.'
            : row.chained
              ? 'Asks first: it follows from what Ares found, not only from your words.'
              : 'Asks first: other people will see it.'}
          {cause && (
            <span data-testid="conversation-action-cause" className="block">
              Suggested because of <cite className="font-semibold text-ink not-italic">{cause.title}</cite>
            </span>
          )}
        </p>
      )}
    </li>
  );
}

/** A change to one of Ares's settings (#197): the setting, its value now and the new one. */
function SettingChange({ name, from, to }: { name: string; from: string; to: string }) {
  return (
    <>
      <p data-testid="conversation-action-setting" className="m-0 text-row leading-6 font-semibold text-ink">
        {name}
      </p>
      <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-note leading-5 text-text">
        <span className={metaClass}>Now</span>
        <span data-testid="conversation-action-from">{from}</span>
        <span aria-hidden className="text-muted">
          →
        </span>
        <span className={metaClass}>New</span>
        <span data-testid="conversation-action-to" className="font-semibold text-ink">
          {to}
        </span>
      </p>
    </>
  );
}

const report = (error: unknown) => toast(error instanceof Error ? error.message : String(error));
