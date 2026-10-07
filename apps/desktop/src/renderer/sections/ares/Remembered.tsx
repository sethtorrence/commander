import type { ConversationTurn } from '@commander/domain';
import { AresText, Button, cn, toast } from '@commander/ui';
import { useState } from 'react';
import { errorText } from '../../projects/change-with-undo';
import type { ConversationsClient } from './conversations';

/*
  What Ares remembered from the User's message (#194): under his answer, a line for each memory it
  learned, changed or forgot ("I’ll remember that you don’t take meetings before 10."), in
  Commander's words around the User's, with Undo, which puts the memory back as it was before the
  message (one the message made goes altogether). An undone line stays, saying so. Drawn in the Ares
  Section and the Ares button's pop-up alike; the turn as it changes arrives from the Core.
*/

const metaClass = 'font-mono text-label leading-none font-medium uppercase tracking-label text-muted';

export function RememberedLines({
  turn,
  client,
  sources,
}: {
  turn: ConversationTurn;
  client: ConversationsClient;
  // What the User wrote in the Conversation: the only links a line may make clickable.
  sources: readonly string[];
}) {
  const [undoing, setUndoing] = useState<string | null>(null);
  if (turn.by !== 'ares' || !turn.remembered.length) return null;

  const undo = async (memoryId: string) => {
    setUndoing(memoryId);
    try {
      await client({
        op: 'undo-remembered',
        conversationId: turn.conversationId,
        turnId: turn.id,
        memoryId,
      });
    } catch (reason) {
      toast(errorText(reason));
    } finally {
      setUndoing(null);
    }
  };

  return (
    <ul aria-label="What Ares remembered" className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
      {turn.remembered.map((line) => (
        <li
          key={line.memoryId}
          data-testid="remembered"
          data-undone={line.undone || undefined}
          className="flex min-h-7 items-center gap-3 border-l-2 border-signal py-0.5 pl-2.5"
        >
          <span
            className={cn(
              'min-w-0 flex-1 text-note leading-5 text-text',
              line.undone && 'text-faint line-through',
            )}
          >
            <AresText inline text={line.line} sources={sources} />
          </span>
          {line.undone ? (
            <span className={metaClass}>Undone</span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={undoing === line.memoryId}
              aria-label={`Undo: ${line.line}`}
              onClick={() => void undo(line.memoryId)}
            >
              Undo
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
