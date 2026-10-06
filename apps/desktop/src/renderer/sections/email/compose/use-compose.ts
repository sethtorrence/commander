import type { ComposeMode, ComposeState, DraftEntry, OutboxEntry } from '@commander/domain';
import { toast } from '@commander/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ItemChanges } from '../../../item-store/changes';
import type { SentMessage } from './Composer';
import type { ComposeClient } from './compose';

/*
  The Email Section's writing (#138): the one composer open (beside the thread for a reply or forward,
  a sheet of its own for new mail and drafts), the Undo toast after each send ("Sending… Undo", for as
  long as the Core holds it), and the Drafts and Outbox views' lists, read again as Items change and
  every second while a message waits to go (its countdown).
*/

export type OpenComposer = { state: ComposeState; placement: 'inline' | 'sheet' };

export interface EmailWriting {
  composer: OpenComposer | null;
  drafts: DraftEntry[];
  outbox: OutboxEntry[];
  /** Opens a composer: new mail, or a reply, reply all or forward of a message (its Item). */
  open(mode: ComposeMode, itemId?: string): Promise<void>;
  openDraft(itemId: string): Promise<void>;
  close(): void;
  /** The composer handed its message to the Core: the Undo toast. */
  sent(sent: SentMessage): void;
  /** Takes a message back before it goes, into the composer again. */
  undo(itemId: string): Promise<void>;
  discard(itemId: string): Promise<void>;
  retry(itemId: string): Promise<void>;
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
  }, [client]);

  useEffect(() => {
    reload();
    return changes(() => reload());
  }, [changes, reload]);

  // While a message waits to go, its countdown and state move on.
  const waiting = outbox.some(
    (entry) => entry.state === 'held' || entry.state === 'sending' || entry.state === 'waiting',
  );
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
    async (mode: ComposeMode, itemId?: string) => {
      try {
        show(await client.open(mode, itemId));
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
    ({ itemId, sendAt }: SentMessage) => {
      setComposer(null);
      reload();
      toast('Sending…', {
        id: `sending-${itemId}`,
        duration: Math.max(1_000, sendAt - now()),
        action: { label: 'Undo', onClick: () => void undo(itemId) },
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

  const close = useCallback(() => {
    setComposer(null);
    reload();
  }, [reload]);

  return {
    composer,
    drafts,
    outbox,
    open,
    openDraft,
    close,
    sent,
    undo,
    discard,
    retry,
    reload,
    current,
    track,
  };
}
