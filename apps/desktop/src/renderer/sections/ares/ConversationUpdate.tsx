import type { UpdateView } from '@commander/domain';
import { toast } from '@commander/ui';
import { useCallback, useEffect, useState } from 'react';
import { useUpdates } from '../../updates/context';
import { UpdateLines } from '../../updates/UpdatePanel';
import { openTarget } from '../../updates/updates';

/*
  The Update Ares gave in a Conversation (#192): the same lines, Items and actions as the Update
  panel, read as the Update stands now (lines acted on anywhere show as such), and read again after
  each action taken here. Open goes where the panel's Open goes, and each line's Reply box (#236) starts
  a Conversation about that line, as in the panel.
*/

export function ConversationUpdate({ updateId }: { updateId: number }) {
  const updates = useUpdates();
  const { past } = updates;
  const [view, setView] = useState<UpdateView | null>(null);
  const [missing, setMissing] = useState(false);

  const reload = useCallback(
    () =>
      past(updateId).then(
        (next) => setView(next),
        () => setMissing(true),
      ),
    [past, updateId],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  if (missing) return null;
  if (!view) {
    return (
      <p className="m-0 mt-2 text-note text-muted" role="status">
        Reading the Update…
      </p>
    );
  }
  return (
    <section
      data-testid="conversation-update"
      aria-label="The Update"
      className="mt-2 border border-line2 bg-sheet"
    >
      <UpdateLines
        view={view}
        onAct={(line, action, snooze) => void updates.act(line, action, snooze).then(reload, report)}
        onActRow={(line, row, action) => void updates.actRow(line, row, action).then(reload, report)}
        onOpen={(line, row, how) =>
          updates.open(openTarget(line, row, { reply: how === 'reply', edit: how === 'edit' }))
        }
        onReply={updates.reply}
        onOpenConversation={updates.openConversation}
      />
    </section>
  );
}

const report = (error: unknown) => toast(error instanceof Error ? error.message : String(error));
