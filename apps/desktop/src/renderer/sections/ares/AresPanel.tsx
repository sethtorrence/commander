import { AresMark, Button, Kbd, Led } from '@commander/ui';
import {
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useReveal } from '../../frame/reveal';
import type { ItemStoreClient } from '../../item-store/client';
import { useCommands } from '../../palette/commands';
import type { AutonomyClient } from './activity';
import { ConversationList } from './ConversationList';
import { ConversationHeading, ConversationThread } from './ConversationThread';
import { ARES_PANEL_REVEAL, type ConversationsClient } from './conversations';
import { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH, type PanelLayoutState, panelWidth } from './panel-layout';
import { type CoreMessages, useConversations } from './use-conversations';

/*
  The Ares panel (#235): Conversations with Ares beside whatever Section the User is in, so they can
  talk to him while reading their email, Linear or the Calendar. It slides open on the right, under
  the tabs, and the Section gives way by its width. The AI mark in the header and Ctrl+J open and
  close it (Ctrl+J from anywhere, a field too); Esc in it hands the focus back to the Section.

  It holds the list of Conversations, newest first, each saying whether Ares is answering, has a card
  waiting or didn't finish, over the open one, drawn as the Ares Section draws it (ConversationList,
  ConversationThread). Several stream at once: switching to another stops none, and the panel hears
  every answer as it is written. It is the stored Conversation throughout, so one can be picked up at
  any time, after a restart too; Full view opens the one it shows in the Ares Section. A link in an
  answer opens its Item in its Section, beside the panel, which stays open.

  Whether it is open, its width (drag its edge, or the arrow keys on it) and its Conversation are
  remembered across Sections and restarts (panel-layout.ts). Everything that opens a Conversation
  from elsewhere opens it here, through openConversation (conversations.ts).
*/

// How far an arrow key on the edge moves it.
const STEP = 16;

/** The window's width, as it changes. */
function useViewWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

export function AresPanel({
  layout,
  client,
  autonomy,
  itemStore,
  onCoreMessage,
  onFullView,
}: {
  layout: PanelLayoutState;
  client: ConversationsClient;
  // The gate, for the cards of what Ares did or prepared (#196).
  autonomy?: AutonomyClient;
  // The Item store, for a meeting's prep an answer made (#198).
  itemStore?: ItemStoreClient;
  onCoreMessage: CoreMessages;
  // Opens a Conversation in the Ares Section, full width.
  onFullView: (conversationId: string) => void;
}) {
  const { open, setOpen, setConversation, setWidth } = layout;
  const state = useConversations(client, open, onCoreMessage, { remembered: layout.conversationId });
  const { today, list, view } = state;
  const openId = view?.conversation.id ?? null;
  const panel = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const viewWidth = useViewWidth();
  const width = panelWidth(layout.width, viewWidth);

  // The turn search or What Ares knows opened it at (#195), shown and marked while it is open.
  const [found, setFound] = useState<{ conversationId: string; turnId: number } | null>(null);
  const foundTurn = found && found.conversationId === openId ? found.turnId : null;

  // The Conversation it shows, remembered.
  useEffect(() => {
    if (openId) setConversation(openId);
  }, [openId, setConversation]);

  // The room the frame makes for it: the Section beside it gives way by its width.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--panel', open ? `${width}px` : '0px');
  }, [open, width]);
  useEffect(
    () => () => {
      document.documentElement.style.removeProperty('--panel');
    },
    [],
  );

  // Where the focus goes back to: what the User was on in the Section before coming into the panel.
  const returnTo = useRef<HTMLElement | null>(null);
  const cameFrom = useCallback((element: EventTarget | null) => {
    if (element instanceof HTMLElement && !panel.current?.contains(element) && element.closest('main'))
      returnTo.current = element;
  }, []);
  const leave = useCallback(() => {
    const back = returnTo.current;
    if (back?.isConnected && back.checkVisibility?.() !== false) back.focus();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, []);

  // The box takes the focus once there is a Conversation to write in.
  const wantsFocus = useRef(false);
  const focusInput = useCallback(() => {
    wantsFocus.current = true;
    const box = input.current;
    if (box && !box.disabled && !box.closest('[hidden]')) {
      box.focus();
      wantsFocus.current = false;
    }
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tried again as the open Conversation arrives
  useEffect(() => {
    if (wantsFocus.current) focusInput();
  }, [openId, open, focusInput]);

  // Opened (the header's mark, Ctrl+J): the box takes the focus. Closed with the focus in it: back
  // to the Section.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current === open) return;
    wasOpen.current = open;
    if (open) {
      cameFrom(document.activeElement);
      focusInput();
    } else if (panel.current?.contains(document.activeElement)) {
      leave();
    }
  }, [open, cameFrom, focusInput, leave]);

  useCommands([
    {
      label: 'Open or close the Ares panel',
      keys: 'Ctrl+j',
      group: 'General',
      inFields: true,
      run: layout.toggle,
    },
  ]);

  // openConversation: a Conversation opened from elsewhere, at a turn when it says which.
  useReveal(ARES_PANEL_REVEAL, (conversationId, focus) => {
    const turnId = focus ? Number(focus) : Number.NaN;
    setFound(Number.isInteger(turnId) ? { conversationId, turnId } : null);
    cameFrom(document.activeElement);
    setOpen(true);
    void state.reveal(conversationId).then(focusInput);
  });

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault();
    leave();
  };

  const answering = list.some((conversation) => conversation.answering);

  return (
    <aside
      ref={panel}
      aria-label="Ares panel"
      data-testid="ares-panel"
      hidden={!open}
      style={{ width }}
      onKeyDown={onKeyDown}
      onFocus={(event: FocusEvent<HTMLElement>) => cameFrom(event.relatedTarget)}
      className="fixed top-(--body) right-0 bottom-0 z-21 flex flex-col border-l border-ink bg-sheet"
    >
      <PanelEdge width={width} viewWidth={viewWidth} onWidth={setWidth} />
      <header className="flex h-9 flex-none items-center gap-2 border-b border-line pr-1.5 pl-3">
        {answering ? <Led size="sm" /> : <AresMark className="text-signal-ink" />}
        <span className="font-mono text-label-lg leading-none font-semibold uppercase tracking-label text-ink">
          Ares
        </span>
        <span className="flex-1" />
        <span className="flex items-center gap-1 font-mono text-label uppercase tracking-label text-faint">
          <Kbd>Ctrl</Kbd>
          <Kbd>J</Kbd>
        </span>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Close the Ares panel"
          title="Close (Ctrl+J)"
          onClick={() => setOpen(false)}
        >
          ×
        </Button>
      </header>
      <ConversationList
        compact
        className="max-h-[34%] flex-none border-b border-line"
        list={list}
        today={today}
        openId={openId}
        onOpen={(conversation) => {
          setFound(null);
          void state.open(conversation.id);
        }}
        onDelete={(conversation) => void state.remove(conversation)}
        onNew={() => {
          void state.startNew().then(focusInput);
        }}
      />
      <div className="flex min-h-0 flex-1 flex-col" data-testid="conversation-thread">
        <ConversationHeading
          compact
          view={view}
          today={today}
          onDelete={() => {
            if (view) void state.remove(view.conversation);
          }}
        >
          <Button
            size="sm"
            variant="ghost"
            title="Open it in the Ares Section, full width"
            onClick={() => {
              if (view) onFullView(view.conversation.id);
            }}
          >
            Full view
          </Button>
        </ConversationHeading>
        <ConversationThread
          state={state}
          client={client}
          autonomy={autonomy}
          itemStore={itemStore}
          onCoreMessage={onCoreMessage}
          size="compact"
          inputRef={input}
          ready={!!view}
          foundTurn={foundTurn}
          onSent={() => setFound(null)}
          hint={
            <>
              <Kbd>↵</Kbd> sends · <Kbd>Esc</Kbd> back
            </>
          }
          empty={() => (
            <>
              Ask Ares anything while you work: what this is about, what you missed, what to do next. He looks
              it up in what Commander holds and links what he found.
            </>
          )}
        />
      </div>
    </aside>
  );
}

/** The panel's left edge: drag it (or use the arrow keys on it) to make the panel wider or narrower. */
function PanelEdge({
  width,
  viewWidth,
  onWidth,
}: {
  width: number;
  viewWidth: number;
  onWidth: (width: number) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const resize = (next: number) => onWidth(panelWidth(next, viewWidth));
  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable splitter, which <hr> can't be
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the Ares panel"
      aria-valuenow={width}
      aria-valuemin={MIN_PANEL_WIDTH}
      aria-valuemax={MAX_PANEL_WIDTH}
      tabIndex={0}
      data-testid="ares-panel-edge"
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { x: event.clientX, width };
      }}
      onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
        const from = drag.current;
        if (from) resize(from.width + from.x - event.clientX);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') resize(width + STEP);
        else if (event.key === 'ArrowRight') resize(width - STEP);
        else return;
        event.preventDefault();
      }}
      className="absolute top-0 bottom-0 -left-[3px] z-1 w-1.5 cursor-col-resize hover:bg-signal focus-visible:bg-signal focus-visible:outline-none"
    />
  );
}
