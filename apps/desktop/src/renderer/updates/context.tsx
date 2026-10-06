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
import { type NewBucketSuggestion, SuggestedNewBucket } from './SuggestedNewBucket';
import { type RuleSuggestion, SuggestedRule } from './SuggestedRule';
import { UpdatePanel } from './UpdatePanel';
import { type OpenTarget, openTarget, type UpdatesClient } from './updates';

/*
  Ares's Updates in the window (#70). He never pops anything up: the header, the tray and the
  Dashboard show a quiet count, and the Update opens only when the User asks for it: `U` (anywhere
  they aren't typing), the header's Ask for an update, the tray's, the Dashboard's, or the palette
  command. Every one of them runs the same Update Skill in the Core.
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
}

const UpdatesContext = createContext<UpdatesApi>({ queued: 0, presence: null, ask: () => {} });

/** The quiet count, presence and Ask for an update, for the header and the Dashboard. */
export const useUpdates = () => useContext(UpdatesContext);

type CoreMessages = (listener: (message: CoreMessage) => void) => () => void;

const report = (error: unknown) => toast(error instanceof Error ? error.message : String(error));

export function UpdatesProvider({
  client,
  onCoreMessage,
  onAskForUpdate,
  onOpen,
  children,
}: {
  client: UpdatesClient | undefined;
  onCoreMessage?: CoreMessages;
  /** The tray's Ask for an update. */
  onAskForUpdate?: (listener: () => void) => () => void;
  /** Open on a line: its Item, its Section or Settings. */
  onOpen: (target: OpenTarget) => void;
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
    const stop = onCoreMessage?.((message) => {
      if (message.type !== 'ares-updates') return;
      heard = true;
      setState({ queued: message.queued, presence: message.presence });
    });
    client?.({ op: 'state' }).then(
      (next) => {
        if (!heard) setState(next);
      },
      () => {},
    );
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

  const act = useCallback(
    async (line: UpdateViewLine, action: QueuedAction, snooze?: SnoozeChoice) => {
      if (!client || panel.mode !== 'update' || !panel.view) return;
      // Accepting a Rule suggestion opens the Rule editor, filled in; the line is done once it is saved.
      const about = line.queued?.about;
      if (
        action === 'accept' &&
        (about?.kind === 'rule-suggestion' || about?.kind === 'bucket-rule-suggestion')
      ) {
        asked.current++;
        setPanel({ mode: 'closed' });
        setRuleSuggestion({ about, queuedId: line.queuedId, at: Date.now() });
        return;
      }
      // Accepting a Bucket Ares suggests opens it, editable; nothing is added until it is saved.
      if (action === 'accept' && about?.kind === 'bucket-suggestion') {
        asked.current++;
        setPanel({ mode: 'closed' });
        setBucketSuggestion({ about, queuedId: line.queuedId, at: Date.now() });
        return;
      }
      try {
        await client({ op: 'act', queuedId: line.queuedId, action, ...(snooze && { snooze }) });
      } catch (error) {
        report(error);
      }
      await refresh(panel.view, panel.past).catch(report);
    },
    [client, panel, refresh],
  );

  // One of a line's Items, acted on in place; the Update shown is read again after.
  const actRow = useCallback(
    async (line: UpdateViewLine, row: UpdateRow, action: RowAction) => {
      if (!client || panel.mode !== 'update' || !panel.view) return;
      try {
        await client({ op: 'act-row', queuedId: line.queuedId, itemId: row.itemId, action });
      } catch (error) {
        report(error);
      }
      await refresh(panel.view, panel.past).catch(report);
    },
    [client, panel, refresh],
  );

  const open = useCallback(
    (line: UpdateViewLine, row?: UpdateRow, reply?: boolean) => {
      close();
      onOpen(openTarget(line, row, { reply }));
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
      client({ op: 'past', id }).then((view) => setPanel({ mode: 'update', view, past: true }), report);
    },
    [client],
  );

  const api = useMemo(() => ({ ...state, ask }), [state, ask]);
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
