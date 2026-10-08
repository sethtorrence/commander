import type {
  CoreMessage,
  Presence,
  QueuedAction,
  RowAction,
  SnoozeChoice,
  UpdateRow,
  UpdateSummary,
  UpdateView,
  UpdateViewLine,
} from '@commander/domain';
import { toast } from '@commander/ui';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useCommands } from '../palette/commands';
import type { ConversationsClient } from '../sections/ares/conversations';
import { dayKey } from '../sections/notes/days';
import { type NewBucketSuggestion, SuggestedNewBucket } from './SuggestedNewBucket';
import { type RuleSuggestion, SuggestedRule } from './SuggestedRule';
import { UpdatePanel } from './UpdatePanel';
import { type OpenTarget, openTarget, type UpdatesClient } from './updates';

/*
  Ares's Updates in the window (#70). He never pops anything up: the header, the tray and the
  Dashboard show a quiet count, and the Update opens only when the User asks for it: `U` (anywhere
  they aren't typing), the header's Ask for an update, the tray's, the Dashboard's, or the palette
  command. Every one of them runs the same Update Skill in the Core.

  Every line has a Reply box (#236): what the User types there goes to the Conversation about the line
  (started then, unless the line has one), which opens in the Ares panel (#235); the line then shows its
  Conversation, and the Conversation links back to the Update here (`reopen`).
*/

export type PanelState =
  | { mode: 'closed' }
  | { mode: 'loading' }
  // `view` is null when nothing was queued. `past` when reopened from Past Updates.
  | { mode: 'update'; view: UpdateView | null; past: boolean }
  | { mode: 'history'; list: UpdateSummary[] | null };

export interface UpdatesApi {
  /** How many things Ares has queued. */
  queued: number;
  presence: Presence | null;
  /** Runs the Update Skill and opens the Update. */
  ask(): void;
  /** Opens where something lives: an Item in its Section, a Section, or Settings. */
  open(target: OpenTarget): void;
  /** An earlier Update as it stands now (one Ares gave in a Conversation, #192). */
  past(id: number): Promise<UpdateView>;
  /** Acts on a line of any Update shown, as the panel does; resolves once it is done. */
  act(line: UpdateViewLine, action: QueuedAction, snooze?: SnoozeChoice): Promise<void>;
  /** Acts on one of a line's Items, as the panel does. */
  actRow(line: UpdateViewLine, row: UpdateRow, action: RowAction): Promise<void>;
  /**
   * The Reply box on a line of Update `updateId` (#236): the User's words go to the Conversation about
   * the line, which opens. Resolves false when they couldn't be sent (and says why).
   */
  reply(updateId: number, line: UpdateViewLine, text: string): Promise<boolean>;
  /** Opens a Conversation with Ares in the Ares panel: the one a line's Reply box started. */
  openConversation(conversationId: string): void;
  /** Opens the Update panel at an Update Ares gave (a Conversation's link back to its line). */
  reopen(updateId: number): void;
}

const UpdatesContext = createContext<UpdatesApi>({
  queued: 0,
  presence: null,
  ask: () => {},
  open: () => {},
  past: () => Promise.reject(new Error('Ares’s Updates aren’t here')),
  act: async () => {},
  actRow: async () => {},
  reply: async () => false,
  openConversation: () => {},
  reopen: () => {},
});

/** The quiet count, presence and Ask for an update, for the header and the Dashboard. */
export const useUpdates = () => useContext(UpdatesContext);

type CoreMessages = (listener: (message: CoreMessage) => void) => () => void;

const report = (error: unknown) => toast(error instanceof Error ? error.message : String(error));

export function UpdatesProvider({
  client,
  onCoreMessage,
  onAskForUpdate,
  onOpen,
  conversations,
  onOpenConversation,
  children,
}: {
  client: UpdatesClient | undefined;
  onCoreMessage?: CoreMessages;
  /** The tray's Ask for an update. */
  onAskForUpdate?: (listener: () => void) => () => void;
  /** Open on a line: its Item, its Section or Settings. */
  onOpen: (target: OpenTarget) => void;
  /** Where a line's Reply box sends the User's words (#236). */
  conversations?: ConversationsClient;
  /** Opens a Conversation in the Ares panel (#235), as Ares's other ways in do. */
  onOpenConversation?: (conversationId: string) => void;
  children: ReactNode;
}) {
  const [state, setState] = useState<{ queued: number; presence: Presence | null }>({
    queued: 0,
    presence: null,
  });
  const [panel, setPanel] = useState<PanelState>({ mode: 'closed' });
  // A Rule Ares suggested, accepted: its editor is open (SuggestedRule).
  const [ruleSuggestion, setRuleSuggestion] = useState<RuleSuggestion | null>(null);
  // A Bucket Ares suggested adding (#141), accepted: its dialog is open (SuggestedNewBucket).
  const [bucketSuggestion, setBucketSuggestion] = useState<NewBucketSuggestion | null>(null);
  // The last answer wins: asking again while one is on its way drops the older one.
  const asked = useRef(0);

  useEffect(() => {
    let heard = false;
    const ask = () =>
      client?.({ op: 'state' }).then(
        (next) => {
          if (!heard) setState(next);
        },
        () => {},
      );
    const stop = onCoreMessage?.((message) => {
      // A new Core after one stopped (#200): asked again.
      if (message.type === 'core-restarted') {
        heard = false;
        void ask();
      }
      if (message.type !== 'ares-updates') return;
      heard = true;
      setState({ queued: message.queued, presence: message.presence });
    });
    void ask();
    return stop;
  }, [client, onCoreMessage]);

  const ask = useCallback(() => {
    if (!client) return;
    const ticket = ++asked.current;
    setPanel({ mode: 'loading' });
    client({ op: 'run-skill', skill: 'update' }).then(
      (view) => ticket === asked.current && setPanel({ mode: 'update', view, past: false }),
      (error) => {
        if (ticket !== asked.current) return;
        setPanel({ mode: 'closed' });
        report(error);
      },
    );
  }, [client]);

  useEffect(() => onAskForUpdate?.(ask), [onAskForUpdate, ask]);

  useCommands([{ label: 'Ask for an update', keys: 'u', group: 'Ares', run: ask }]);

  const close = useCallback(() => {
    asked.current++;
    setPanel({ mode: 'closed' });
  }, []);

  // Reads the Update shown again, so lines acted on show as such.
  const refresh = useCallback(
    async (view: UpdateView, past: boolean) => {
      if (!client) return;
      const next = await client({ op: 'past', id: view.id });
      setPanel((now) =>
        now.mode === 'update' && now.view?.id === view.id ? { mode: 'update', view: next, past } : now,
      );
    },
    [client],
  );

  // Acts on a line of any Update shown. Accepting a Rule suggestion opens the Rule editor, filled in
  // (the line is done once it is saved), and accepting a Bucket Ares suggests opens it, editable
  // (nothing is added until it is saved): 'editor'. Anything else goes to the Core.
  const actOnLine = useCallback(
    async (line: UpdateViewLine, action: QueuedAction, snooze?: SnoozeChoice): Promise<'editor' | 'done'> => {
      if (!client) return 'done';
      const about = line.queued?.about;
      if (
        action === 'accept' &&
        (about?.kind === 'rule-suggestion' || about?.kind === 'bucket-rule-suggestion')
      ) {
        setRuleSuggestion({ about, queuedId: line.queuedId, at: Date.now() });
        return 'editor';
      }
      if (action === 'accept' && about?.kind === 'bucket-suggestion') {
        setBucketSuggestion({ about, queuedId: line.queuedId, at: Date.now() });
        return 'editor';
      }
      await client({ op: 'act', queuedId: line.queuedId, action, ...(snooze && { snooze }) });
      return 'done';
    },
    [client],
  );

  const actOnRow = useCallback(
    async (line: UpdateViewLine, row: UpdateRow, action: RowAction) => {
      if (!client) return;
      await client({ op: 'act-row', queuedId: line.queuedId, itemId: row.itemId, action });
    },
    [client],
  );

  const act = useCallback(
    async (line: UpdateViewLine, action: QueuedAction, snooze?: SnoozeChoice) => {
      if (!client || panel.mode !== 'update' || !panel.view) return;
      const view = panel.view;
      const past = panel.past;
      // An editor opened over the panel: the panel closes.
      const acted = await actOnLine(line, action, snooze).catch((error: unknown) => {
        report(error);
        return 'done' as const;
      });
      if (acted === 'editor') {
        asked.current++;
        setPanel({ mode: 'closed' });
        return;
      }
      await refresh(view, past).catch(report);
    },
    [client, panel, refresh, actOnLine],
  );

  // One of a line's Items, acted on in place; the Update shown is read again after.
  const actRow = useCallback(
    async (line: UpdateViewLine, row: UpdateRow, action: RowAction) => {
      if (!client || panel.mode !== 'update' || !panel.view) return;
      await actOnRow(line, row, action).catch(report);
      await refresh(panel.view, panel.past).catch(report);
    },
    [client, panel, refresh, actOnRow],
  );

  const open = useCallback(
    (line: UpdateViewLine, row?: UpdateRow, how?: 'reply' | 'edit') => {
      close();
      onOpen(openTarget(line, row, { reply: how === 'reply', edit: how === 'edit' }));
    },
    [close, onOpen],
  );

  const showHistory = useCallback(() => {
    if (!client) return;
    setPanel({ mode: 'history', list: null });
    client({ op: 'history' }).then(
      (list) => setPanel((now) => (now.mode === 'history' ? { mode: 'history', list } : now)),
      report,
    );
  }, [client]);

  const reopen = useCallback(
    (id: number) => {
      if (!client) return;
      const ticket = ++asked.current;
      client({ op: 'past', id }).then(
        (view) => ticket === asked.current && setPanel({ mode: 'update', view, past: true }),
        report,
      );
    },
    [client],
  );

  const openConversation = useCallback(
    (conversationId: string) => {
      close();
      onOpenConversation?.(conversationId);
    },
    [close, onOpenConversation],
  );

  // The Reply box on a line (#236): the User's words, in the Conversation about the line, which opens.
  const reply = useCallback(
    async (updateId: number, line: UpdateViewLine, text: string) => {
      if (!conversations) return false;
      try {
        const view = await conversations({
          op: 'reply-to-line',
          day: dayKey(new Date()),
          updateId,
          queuedId: line.queuedId,
          text,
        });
        openConversation(view.conversation.id);
        return true;
      } catch (error) {
        report(error);
        return false;
      }
    },
    [conversations, openConversation],
  );

  const past = useCallback(
    (id: number) => (client ? client({ op: 'past', id }) : Promise.reject(new Error('Ares isn’t running'))),
    [client],
  );
  const lineAct = useCallback(
    async (line: UpdateViewLine, action: QueuedAction, snooze?: SnoozeChoice) => {
      await actOnLine(line, action, snooze);
    },
    [actOnLine],
  );

  const api = useMemo(
    () => ({
      ...state,
      ask,
      open: onOpen,
      past,
      act: lineAct,
      actRow: actOnRow,
      reply,
      openConversation,
      reopen,
    }),
    [state, ask, onOpen, past, lineAct, actOnRow, reply, openConversation, reopen],
  );
  return (
    <UpdatesContext.Provider value={api}>
      {children}
      <UpdatePanel
        state={panel}
        onClose={close}
        onAct={act}
        onOpen={open}
        onActRow={actRow}
        onShowHistory={showHistory}
        onReopen={reopen}
        onReply={conversations ? reply : undefined}
        onOpenConversation={openConversation}
      />
      {ruleSuggestion && (
        <SuggestedRule
          suggestion={ruleSuggestion}
          onSaved={(queuedId) => void client?.({ op: 'act', queuedId, action: 'done' }).catch(report)}
        />
      )}
      {bucketSuggestion && (
        <SuggestedNewBucket
          suggestion={bucketSuggestion}
          onSaved={(queuedId) => void client?.({ op: 'act', queuedId, action: 'done' }).catch(report)}
        />
      )}
    </UpdatesContext.Provider>
  );
}
