import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Kbd,
  toast,
} from '@commander/ui';
import { type FormEvent, type ReactNode, useCallback, useState } from 'react';
import { ItemBadge } from '../../projects/badges';
import type { EmailTodoDraft } from './email-todo';

/*
  Make it a Todo (#140), as the User sees it: a small dialog with the Todo's title (the subject, to
  edit before it is made), the Project it takes from the email, and who the email is from. Enter adds
  it; Esc leaves it. Keys typed in the title never reach the shortcut layer.
*/

export function MakeTodoDialog({
  draft,
  onMake,
  onClose,
}: {
  draft: EmailTodoDraft;
  /** Adds the Todo with the title as typed (trimmed, never empty). */
  onMake: (title: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(draft.title);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim()) onMake(title.trim());
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(480px,calc(100vw-48px))]">
        <DialogHeader partNumber="EML-T">
          <DialogTitle>Make it a Todo</DialogTitle>
        </DialogHeader>
        <DialogDescription className="sr-only">
          A Todo made from the email, linked to it and under its Project
        </DialogDescription>
        <form onSubmit={submit}>
          <DialogBody className="flex flex-col gap-3">
            <label
              htmlFor="email-todo-title"
              className="flex flex-col gap-1 font-mono text-label uppercase tracking-label text-muted"
            >
              Title
              <Input
                id="email-todo-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="normal-case"
              />
            </label>
            <p className="m-0 flex items-center gap-2 font-mono text-label leading-none uppercase tracking-label text-muted">
              <ItemBadge filing={draft.filing} />
              From email{draft.sender ? ` · ${draft.sender}` : ''}
            </p>
          </DialogBody>
          <DialogFooter>
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!title.trim()}>
              Add Todo <Kbd>↵</Kbd>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The dialog, opened on a draft (`open`), for the Email Section and the Dashboard: adding the Todo
 * runs `make`, which resolves with how to undo it (or null when nothing was made), then a toast says
 * so with Undo.
 */
export function useMakeTodo(make: (draft: EmailTodoDraft) => Promise<(() => void) | null>): {
  open: (draft: EmailTodoDraft) => void;
  dialog: ReactNode;
} {
  const [draft, setDraft] = useState<EmailTodoDraft | null>(null);
  const open = useCallback((next: EmailTodoDraft) => setDraft(next), []);
  const add = async (title: string) => {
    if (!draft) return;
    setDraft(null);
    try {
      const undo = await make({ ...draft, title });
      if (undo) toast(`Todo added: ${title}`, { action: { label: 'Undo', onClick: undo } });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  };
  const dialog = draft && (
    <MakeTodoDialog draft={draft} onClose={() => setDraft(null)} onMake={(title) => void add(title)} />
  );
  return { open, dialog };
}
