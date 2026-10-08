import { useRef, useState } from 'react';
import { useReveal } from '../../frame/reveal';
import type { ItemStoreClient } from '../../item-store/client';
import { SettingsGroup } from '../../settings/parts';
import type { AutonomyClient } from './activity';
import { ConversationList } from './ConversationList';
import { ConversationHeading, ConversationThread } from './ConversationThread';
import { CONVERSATIONS_REVEAL, type ConversationsClient } from './conversations';
import { type CoreMessages, useConversations } from './use-conversations';

/*
  Conversations (#191): talking to Ares in the Ares Section. The list of Conversations, newest first,
  beside the open one; opening the Section lands on today's, and New Conversation starts another.
  Type and press Enter (Shift+Enter for a new line): Ares's answer appears as he writes it, drawn with
  AresText (text only, nothing loaded, and only a link the User gave is clickable), with "From
  Ares's own knowledge" under an answer that came from the model rather than the User's data. With
  his Skills (#192) he says what he is doing while one runs ("Looking it up…"); each Item his answer
  rests on is a link that opens it in its Section, and an Update he gave shows under his words with
  its lines and actions, as in the Update panel. Stop
  ends it early and keeps what he wrote; a failed answer says why in his voice, and Send again asks
  him once more. Several run at once; with a model on this machine an answer may wait its turn, and
  says so. Delete removes one, with Undo in the toast. Each Conversation keeps its own unsent words.
  One started from an Item with the Ares button (#193) names that Item under its title, opening it
  where it lives.
  What his action Skills did or prepared (#196) shows under his words as cards (ConversationActions):
  done, with Undo, or waiting for the User, whose Confirm takes the focus when the answer arrives and
  nothing is typed, so one key (Enter) confirms it.
  What he remembered from the User's message (#194) shows under his words as lines with Undo
  (Remembered).
  What Draft, Schedule and Meeting prep made (#198) shows there too (ConversationMade): a draft reply
  with Open in composer, a meeting's prep.
  This is the full-width view (#235). Everywhere else a Conversation opens in the Ares panel beside
  the Section the User is in (openConversation); the panel's Full view opens its Conversation here.
  The thread and the list are the ones the panel and the Ares button's pop-up draw too
  (ConversationThread, ConversationList).
*/

const pad = (n: number) => String(n).padStart(2, '0');

export function Conversations({
  client,
  autonomy,
  itemStore,
  shown,
  onCoreMessage,
  no = 'A4',
}: {
  client: ConversationsClient;
  // The gate, for the cards of what Ares did or prepared (#196); without it they don't show.
  autonomy?: AutonomyClient;
  // The Item store, for a meeting's prep an answer made (#198).
  itemStore?: ItemStoreClient;
  shown: boolean;
  onCoreMessage: CoreMessages;
  no?: string;
}) {
  const state = useConversations(client, shown, onCoreMessage);
  const { today, list, view } = state;
  const openId = view?.conversation.id ?? null;
  const group = useRef<HTMLDivElement>(null);

  // The turn search found (#195), shown and marked while its Conversation is open.
  const [found, setFound] = useState<{ conversationId: string; turnId: number } | null>(null);
  const foundTurn = found && found.conversationId === openId ? found.turnId : null;

  // The Ares panel's Full view opens its Conversation here (#235), at a turn when it says which.
  useReveal(CONVERSATIONS_REVEAL, (conversationId, focus) => {
    const turnId = focus ? Number(focus) : Number.NaN;
    setFound(Number.isInteger(turnId) ? { conversationId, turnId } : null);
    void state.reveal(conversationId).then(() =>
      // Once the Section is shown.
      requestAnimationFrame(() => group.current?.scrollIntoView?.({ block: 'start' })),
    );
  });

  return (
    <SettingsGroup
      no={no}
      title="Conversations"
      note={`${pad(list.length)} Conversations`}
      data-testid="conversations"
    >
      <div
        ref={group}
        className="grid scroll-mt-(--body) grid-cols-[260px_minmax(0,1fr)] border-b border-line2"
      >
        <ConversationList
          className="border-r border-line2"
          list={list}
          today={today}
          openId={openId}
          onOpen={(conversation) => void state.open(conversation.id)}
          onDelete={(conversation) => void state.remove(conversation)}
          onNew={() => void state.startNew()}
        />
        <div className="flex min-w-0 flex-col" data-testid="conversation-thread">
          <ConversationHeading
            view={view}
            today={today}
            onDelete={() => {
              if (view) void state.remove(view.conversation);
            }}
          />
          <ConversationThread
            state={state}
            client={client}
            autonomy={autonomy}
            itemStore={itemStore}
            onCoreMessage={onCoreMessage}
            ready={!!view}
            foundTurn={foundTurn}
            onSent={() => setFound(null)}
            empty={() => (
              <>
                Ask Ares anything: what’s on today, what you missed, where that email went. He looks it up in
                what Commander holds and links what he found; general questions he answers from what he knows.
              </>
            )}
          />
        </div>
      </div>
    </SettingsGroup>
  );
}
