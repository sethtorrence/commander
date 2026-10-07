import {
  type ComposeBody,
  type ComposeMode,
  type ComposeState,
  type DraftEntry,
  type OutboxEntry,
  type ScheduledEntry,
  type SendLaterHeldBy,
  sendLaterTime,
} from '@commander/domain';
import { toast } from '@commander/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ItemChanges } from '../../../item-store/changes';
import type { SentMessage } from './Composer';
import type { ComposeClient } from './compose';

/*
  The Email Section's writing (#138): the one composer open (beside the thread for a reply or forward,
  a sheet of its own for new mail and drafts), the Undo toast after each send ("Sending… Undo", for as
  long as the Core holds it), and the Drafts, Outbox and Scheduled views' lists, read again as Items
  change and every second while a message waits to go (its countdown) or is being handed to Microsoft.
  Send later (#139): the toast after scheduling (Undo takes it back into the composer), and Scheduled's
  Edit, Change time, Send now and Cancel.
*/

export type OpenComposer = { state: ComposeState; placement: 'inline' | 'sheet' };

/** A message the composer scheduled (#139). */
export type ScheduledMessage = { itemId: string; sendAt: number; heldBy: SendLaterHeldBy };

export interface EmailWriting {
  composer: OpenComposer | null;
  drafts: DraftEntry[];
  outbox: OutboxEntry[];
  scheduled: ScheduledEntry[];
  /**
   * Opens a composer: new mail, or a reply, reply all or forward of a message (its Item). `opening`:
   * what the body starts with, above the signature (Reply with your booking link, #144).
   */
  open(mode: ComposeMode, itemId?: string, opening?: ComposeBody): Promise<void>;
  openDraft(itemId: string): Promise<void>;
  /** Ares's suggested reply to a message (#143), in the composer below its thread, as a draft. */
  openSuggested(itemId: string): Promise<void>;
  close(): void;
  /**
   * The composer handed its message to the Core: the Undo toast. Its Undo takes the message back
   * (`undo`), or does `onUndo` instead where taking it back means more (Triage goes back to its thread).
   */
  sent(sent: SentMessage, onUndo?: () => void): void;
  /** Takes a message back before it goes, into the composer again. */
  undo(itemId: string): Promise<void>;
  discard(itemId: string): Promise<void>;
  retry(itemId: string): Promise<void>;
  /** Send later (#139): the composer handed its message over to go later. */
  scheduledSent(scheduled: ScheduledMessage): void;
  /** Edit: a scheduled message back in the composer, its time offered again. */
  editScheduled(itemId: string): Promise<void>;
  reschedule(itemId: string, sendAt: number): Promise<void>;
  sendNow(itemId: string): Promise<void>;
  cancelScheduled(itemId: string): Promise<void>;
  reload(): void;
  /** The open composer's message as it now is (what a composer shown again starts from). */
  current(): ComposeState | null;
  track(state: ComposeState): void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function useCompose({
  client,
  changes,
  now = Date.now,
}: {
  client: ComposeClient;
  changes: ItemChanges;
  now?: () => number;
}): EmailWriting {
  const [composer, setComposer] = useState<OpenComposer | null>(null);
  const [drafts, setDrafts] = useState<DraftEntry[]>([]);
  const [outbox, setOutbox] = useState<OutboxEntry[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledEntry[]>([]);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const reload = useCallback(() => {
    client.drafts().then(
      (found) => alive.current && setDrafts(found),
      () => {},
    );
    client.outbox().then(
      (found) => alive.current && setOutbox(found),
      () => {},
    );
    client.scheduled().then(
      (found) => alive.current && setScheduled(found),
      () => {},
    );
  }, [client]);

  useEffect(() => {
    reload();
    return changes(() => reload());
  }, [changes, reload]);

  // While a message waits to go, its countdown and state move on.
  const waiting =
    outbox.some(
      (entry) => entry.state === 'held' || entry.state === 'sending' || entry.state === 'waiting',
    ) || scheduled.some((entry) => entry.state === 'handing');
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => reload(), 1_000);
    return () => clearInterval(timer);
  }, [waiting, reload]);

  const latest = useRef<ComposeState | null>(null);
  const show = useCallback((state: ComposeState, placement?: OpenComposer['placement']) => {
    latest.current = state;
    setComposer({
      state,
      placement: placement ?? (state.mode === 'new' || !state.replyToItemId ? 'sheet' : 'inline'),
    });
  }, []);
  const track = useCallback((state: ComposeState) => {
    latest.current = state;
  }, []);
  const current = useCallback(() => latest.current, []);

  const open = useCallback(
    async (mode: ComposeMode, itemId?: string, opening?: ComposeBody) => {
      try {
        const state = await client.open(mode, itemId);
        show(opening?.length ? { ...state, body: [...opening, ...state.body] } : state);
      } catch (error) {
        toast(message(error));
      }
    },
    [client, show],
  );

  const openDraft = useCallback(
    async (itemId: string) => {
      try {
        show(await client.openDraft(itemId), 'sheet');
      } catch (error) {
        toast(message(error));
      }
    },
    [client, show],
  );

  const openSuggested = useCallback(
    async (itemId: string) => {
      try {
        show(await client.openSuggested(itemId), 'inline');
        reload();
      } catch (error) {
        toast(message(error));
      }
    },
    [client, show, reload],
  );

  const undo = useCallback(
    async (itemId: string) => {
      try {
        show(await client.undoSend(itemId));
        reload();
      } catch (error) {
        toast(message(error));
      }
    },
    [client, show, reload],
  );

  const sent = useCallback(
    ({ itemId, sendAt }: SentMessage, onUndo?: () => void) => {
      setComposer(null);
      reload();
      toast('Sending…', {
        id: `sending-${itemId}`,
        duration: Math.max(1_000, sendAt - now()),
        action: { label: 'Undo', onClick: () => (onUndo ? onUndo() : void undo(itemId)) },
      });
    },
    [reload, undo, now],
  );

  const discard = useCallback(
    async (itemId: string) => {
      try {
        await client.discard(itemId);
        if (composer?.state.itemId === itemId) setComposer(null);
        toast('Draft discarded');
      } catch (error) {
        toast(message(error));
      }
      reload();
    },
    [client, composer, reload],
  );

  const retry = useCallback(
    async (itemId: string) => {
      try {
        await client.retry(itemId);
      } catch (error) {
        toast(message(error));
      }
      reload();
    },
    [client, reload],
  );

  const editScheduled = useCallback(
    async (itemId: string) => {
      try {
        show(await client.editScheduled(itemId));
      } catch (error) {
        toast(message(error));
      }
      reload();
    },
    [client, show, reload],
  );

  const scheduledSent = useCallback(
    ({ itemId, sendAt }: ScheduledMessage) => {
      setComposer(null);
      reload();
      toast(`Scheduled for ${sendLaterTime(sendAt, now())}`, {
        id: `scheduled-${itemId}`,
        action: { label: 'Undo', onClick: () => void editScheduled(itemId) },
      });
    },
    [reload, editScheduled, now],
  );

  // Scheduled's Change time, Send now and Cancel: each says what it did.
  const scheduledAction = useCallback(
    async (run: () => Promise<void>, said: string) => {
      try {
        await run();
        toast(said);
      } catch (error) {
        toast(message(error));
      }
      reload();
    },
    [reload],
  );
  const reschedule = useCallback(
    (itemId: string, sendAt: number) =>
      scheduledAction(
        () => client.reschedule(itemId, sendAt),
        `Rescheduled for ${sendLaterTime(sendAt, now())}`,
      ),
    [client, scheduledAction, now],
  );
  const sendNow = useCallback(
    (itemId: string) => scheduledAction(() => client.sendNow(itemId), 'Sending now'),
    [client, scheduledAction],
  );
  const cancelScheduled = useCallback(
    (itemId: string) =>
      scheduledAction(() => client.cancelScheduled(itemId), 'Cancelled: it’s back in Drafts'),
    [client, scheduledAction],
  );

  const close = useCallback(() => {
    setComposer(null);
    reload();
  }, [reload]);

  return {
    composer,
    drafts,
    outbox,
    scheduled,
    open,
    openDraft,
    openSuggested,
    close,
    sent,
    undo,
    discard,
    retry,
    scheduledSent,
    editScheduled,
    reschedule,
    sendNow,
    cancelScheduled,
    reload,
    current,
    track,
  };
}
