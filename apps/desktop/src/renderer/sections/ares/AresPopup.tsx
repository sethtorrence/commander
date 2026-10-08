import type { ItemKind } from '@commander/domain';
import { AresMark, Button, Kbd, Led, usePortalContainer } from '@commander/ui';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ItemStoreClient } from '../../item-store/client';
import { type AresActions, AresProvider, type AresTarget } from '../../links/AresButton';
import { KindTag } from '../todos/detail/parts';
import { kindTag } from '../todos/links';
import type { AutonomyClient } from './activity';
import { ConversationThread } from './ConversationThread';
import { answeringTurn, type ConversationsClient } from './conversations';
import { useConversation } from './use-conversation';
import type { CoreMessages } from './use-conversations';

/*
  The Ares button's pop-up (#193, decisions #24, #29): a small Conversation beside the Item the Ares
  button (or `a`) was pressed on, so the User can talk to Ares about it without leaving where they
  are. It is a Conversation like any other: nothing is made until the User sends a message, which
  starts a new Conversation about the Item (the Core hands Ares the Item with every message, by where
  it came from); his answer streams in as in the Ares Section, drawn the same way, with the same
  links and Updates, by the same thread (ConversationThread). Esc closes it (the Conversation stays,
  saved and listed); Open in Ares moves it into the Ares panel beside the Section (#235), where it
  carries on. Pressing another Item's button starts afresh.

  <AresPopupHost> gives every Ares button below it this pop-up (links/AresButton.tsx); the frame
  mounts it once.
*/

const WIDTH = 400;
const HEIGHT = 480;
const GAP = 8;
const MARGIN = 12;

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(value, Math.max(low, high)));

/** Where the pop-up stands: beside the button (right of it, else left), else at the window's right. */
export function placeBeside(
  anchor: Pick<DOMRect, 'left' | 'right' | 'top'> | null,
  view: { width: number; height: number },
): { left: number; top: number } {
  if (!anchor)
    return { left: view.width - WIDTH - 24, top: clamp(view.height - HEIGHT - 24, MARGIN, view.height) };
  const right = anchor.right + GAP;
  const left = right + WIDTH <= view.width - MARGIN ? right : anchor.left - GAP - WIDTH;
  return {
    left: clamp(left, MARGIN, view.width - WIDTH - MARGIN),
    top: clamp(anchor.top - 14, MARGIN, view.height - HEIGHT - MARGIN),
  };
}

// What an Item is, in the pop-up's words: "Ask about this email".
const KIND_WORDS: Partial<Record<ItemKind, string>> = {
  email: 'email',
  event: 'event',
  'linear-issue': 'issue',
  'pull-request': 'pull request',
  'review-request': 'review request',
  'github-issue': 'issue',
  'github-release': 'release',
  chat: 'Chat',
  'channel-post': 'post',
  todo: 'Todo',
  block: 'line',
  'daily-note': 'Daily Note',
};

// What the User might ask first, one click away.
const STARTERS = ['What’s this about?', 'What should I do about it?'];

type Opened = { target: AresTarget; anchor: DOMRect | null; from: Element | null; press: number };

export function AresPopupHost({
  client,
  autonomy,
  itemStore,
  onCoreMessage,
  onExpand,
  children,
}: {
  client: ConversationsClient;
  /** The gate, for the cards of what Ares did or prepared (#196). */
  autonomy?: AutonomyClient;
  /** The Item store, for a meeting's prep an answer made (#198). */
  itemStore?: ItemStoreClient;
  onCoreMessage: CoreMessages;
  /** Opens a Conversation in the Ares panel (openConversation). */
  onExpand: (conversationId: string) => void;
  children: ReactNode;
}) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const actions = useMemo<AresActions>(
    () => ({
      open(target, anchor) {
        const from = document.activeElement;
        setOpened((current) =>
          // The same Item's button again: the pop-up stays as it is.
          current?.target.id === target.id
            ? current
            : {
                target,
                anchor: anchor?.getBoundingClientRect() ?? null,
                from,
                press: (current?.press ?? 0) + 1,
              },
        );
      },
    }),
    [],
  );
  const shown = useRef(opened);
  shown.current = opened;
  const close = useCallback(() => {
    // Back to where the User was.
    const from = shown.current?.from;
    setOpened(null);
    if (from instanceof HTMLElement && from.isConnected) from.focus();
  }, []);
  return (
    <AresProvider value={actions}>
      {children}
      {opened && (
        <AresPopup
          key={opened.press}
          target={opened.target}
          anchor={opened.anchor}
          client={client}
          autonomy={autonomy}
          itemStore={itemStore}
          onCoreMessage={onCoreMessage}
          onClose={close}
          // Open in composer on a draft (#198): the User is taken to it, so the pop-up goes.
          onLeave={() => setOpened(null)}
          onExpand={(conversationId) => {
            setOpened(null);
            onExpand(conversationId);
          }}
        />
      )}
    </AresProvider>
  );
}

export function AresPopup({
  target,
  anchor,
  client,
  autonomy,
  itemStore,
  onCoreMessage,
  onClose,
  onLeave,
  onExpand,
}: {
  target: AresTarget;
  anchor: DOMRect | null;
  client: ConversationsClient;
  autonomy?: AutonomyClient;
  itemStore?: ItemStoreClient;
  onCoreMessage: CoreMessages;
  onClose: () => void;
  // The User went to what an answer made (a draft opened in the composer): closes without refocusing.
  onLeave?: () => void;
  onExpand: (conversationId: string) => void;
}) {
  const state = useConversation(client, onCoreMessage, target.id);
  const { view } = state;
  const popup = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const container = usePortalContainer();
  const [place] = useState(() =>
    placeBeside(anchor, { width: window.innerWidth, height: window.innerHeight }),
  );
  const answering = answeringTurn(view);
  const kind = KIND_WORDS[target.kind] ?? 'Item';

  useEffect(() => input.current?.focus(), []);

  // Esc closes it, wherever the User is, before anything else hears the key; a dialog or menu of its
  // own (the cheat sheet, a picker) keeps its Esc.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      const at = event.target instanceof Element ? event.target : null;
      const elsewhere = at?.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
      if (elsewhere && !popup.current?.contains(elsewhere)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const expand = async () => {
    const conversationId = await state.start();
    if (conversationId) onExpand(conversationId);
  };

  const title = target.title.trim() || 'Untitled';

  return createPortal(
    <section
      ref={popup}
      role="dialog"
      aria-modal="false"
      aria-label={`Ares on ${title}`}
      data-testid="ares-popup"
      style={{ left: place.left, top: place.top, width: WIDTH }}
      className="fixed z-40 flex max-h-[min(480px,calc(100vh-24px))] flex-col border border-ink bg-sheet shadow-[4px_4px_0_var(--line)]"
    >
      <header className="flex h-9 flex-none items-center gap-2 border-b border-line pr-1.5 pl-3">
        {answering ? <Led size="sm" /> : <AresMark className="text-signal-ink" />}
        <span className="font-mono text-label-lg leading-none font-semibold uppercase tracking-label text-ink">
          Ares
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => void expand()} title="Carry on in the Ares panel">
          Open in Ares
        </Button>
        <Button size="sm" variant="ghost" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          ×
        </Button>
      </header>
      <div
        className="flex flex-none items-center gap-2 border-b border-line2 px-3 py-1.5"
        data-testid="ares-popup-about"
      >
        <KindTag>{kindTag(target.kind)}</KindTag>
        <span className="min-w-0 flex-1 truncate text-note text-text" title={title}>
          {title}
        </span>
      </div>
      <ConversationThread
        state={state}
        client={client}
        autonomy={autonomy}
        itemStore={itemStore}
        onCoreMessage={onCoreMessage}
        size="compact"
        inputRef={input}
        onLeave={onLeave}
        placeholder={`Ask about this ${kind}…`}
        hint={
          <>
            <Kbd>↵</Kbd> sends · <Kbd>Esc</Kbd> closes
          </>
        }
        empty={(send) => (
          <>
            Ask Ares about this {kind}. He has it in front of him, and looks up anything else he needs.
            <span className="mt-2.5 flex flex-wrap gap-1.5">
              {STARTERS.map((starter) => (
                <Button key={starter} size="sm" onClick={() => send(starter)}>
                  {starter}
                </Button>
              ))}
            </span>
          </>
        )}
      />
    </section>,
    container ?? document.body,
  );
}
