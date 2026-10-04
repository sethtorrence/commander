import type { LinearCatalog, LinearIssueDraft } from '@commander/domain';
import type { AccountSummary } from '@commander/domain/ipc';
import {
  Button,
  cn,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  inputVariants,
  Kbd,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@commander/ui';
import { type FormEvent, type KeyboardEvent, type ReactNode, useCallback, useRef, useState } from 'react';
import { PRIORITY_NAMES } from './glyphs';
import { type LinearAccountsClient, linearAccountsIn } from './linear-issues';
import {
  assigneeChoices,
  type Catalogs,
  chosenTeam,
  draftOf,
  initialForm,
  type LinearSender,
  linearSenderIn,
  type SendForm,
  type SendTarget,
  sendableAccounts,
  withTeam,
} from './send-to-linear';

/*
  The Send to Linear dialog (send-to-linear.ts has its logic): the title, the workspace and team, the
  assignee (the User), the state (the team's default), the priority and an optional description, which
  is sent once, when the issue is made, and read-only in Commander after that. Any Section opens it
  with useSendToLinear: a Todo (Todos), a Block (Notes) or nothing (New Linear issue, in Linear).
  Sending shows a toast with Undo, which deletes the issue in Linear and puts back what it changed.
*/

/** A send as the Section recorded it: the new issue, and how to undo it. */
export interface Sent {
  issueId: string;
  undo(): void;
}

export interface SendToLinearOptions {
  /** Records the send; by default straight through the Item store, undone from the toast. */
  send?: (draft: LinearIssueDraft) => Promise<Sent | null>;
  /** Called once an issue is sent. */
  onSent?: (sent: Sent) => void;
  sender?: LinearSender;
  accounts?: LinearAccountsClient;
}

type Opened = {
  target: SendTarget;
  heading: string;
  accounts: AccountSummary[];
  catalogs: Catalogs;
  form: SendForm;
};

const NONE = '__none';
const label =
  'mb-1.5 block font-mono text-label leading-none font-semibold uppercase tracking-label text-muted';

const report = (error: unknown) => toast(error instanceof Error ? error.message : String(error));

/** The Send to Linear dialog for a Section: `open` it for a Todo or Block, or for a new issue. */
export function useSendToLinear(options: SendToLinearOptions = {}): {
  open(target: SendTarget, heading?: string): void;
  dialog: ReactNode;
} {
  const [opened, setOpened] = useState<Opened | null>(null);
  const latest = useRef(options);
  latest.current = options;
  // The window's bridge, reached only once the dialog is used (component tests render without it).
  const sender = useCallback(() => latest.current.sender ?? linearSenderIn(window.commander.itemStore), []);
  const accountsClient = useCallback(() => latest.current.accounts ?? linearAccountsIn(window.commander), []);
  // A second open while the first is still loading wins.
  const opening = useRef(0);

  const open = useCallback(
    (target: SendTarget, heading = 'Send to Linear') => {
      const ticket = ++opening.current;
      void (async () => {
        const accounts = (await accountsClient().list()).filter((account) => account.status === 'connected');
        const [prefill, found] = await Promise.all([
          sender().prefill(target),
          Promise.all(
            accounts.map(async (account) => [account.id, await sender().catalog(account.id)] as const),
          ),
        ]);
        if (ticket !== opening.current) return;
        const catalogs = new Map<string, LinearCatalog | null>(found);
        setOpened({ target, heading, accounts, catalogs, form: initialForm(prefill, accounts, catalogs) });
      })().catch(report);
    },
    [accountsClient, sender],
  );

  const close = useCallback(() => {
    opening.current += 1;
    setOpened(null);
  }, []);

  const submit = useCallback(
    async (draft: LinearIssueDraft) => {
      const record =
        latest.current.send ??
        (async (sent: LinearIssueDraft): Promise<Sent | null> => {
          const entries = await sender().send(sent);
          const issueId = entries[0]?.itemId;
          if (!issueId) return null;
          const ids = entries.map((entry) => entry.id);
          return { issueId, undo: () => void sender().undo(ids).catch(report) };
        });
      try {
        const sent = await record(draft);
        if (!sent) return;
        setOpened(null);
        toast(`Sent to Linear: ${draft.title}`, { action: { label: 'Undo', onClick: () => sent.undo() } });
        latest.current.onSent?.(sent);
      } catch (error) {
        report(error);
      }
    },
    [sender],
  );

  const dialog = (
    <Dialog open={opened !== null} onOpenChange={(open) => !open && close()}>
      {opened && (
        <SendDialog
          key={opened.target.from ?? 'new'}
          opened={opened}
          onChange={(form) => setOpened((now) => now && { ...now, form })}
          onSend={submit}
          onCancel={close}
        />
      )}
    </Dialog>
  );
  return { open, dialog };
}

function Field({ id, name, children }: { id: string; name: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={label}>
        {name}
      </label>
      {children}
    </div>
  );
}

function Picker({
  id,
  name,
  value,
  onChange,
  disabled,
  children,
}: {
  id: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Field id={id} name={name}>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} aria-label={name}>
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
    </Field>
  );
}

function SendDialog({
  opened,
  onChange,
  onSend,
  onCancel,
}: {
  opened: Opened;
  onChange: (form: SendForm) => void;
  onSend: (draft: LinearIssueDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const { target, heading, accounts, catalogs, form } = opened;
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const usable = sendableAccounts(accounts, catalogs);
  const team = chosenTeam(form, catalogs);
  const teams = (form.account && catalogs.get(form.account)?.teams) || [];
  const people = assigneeChoices(accounts, catalogs, form);
  const me = accounts.find((account) => account.id === form.account)?.user?.id ?? null;
  const set = (changes: Partial<SendForm>) => onChange({ ...form, ...changes });

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (sending) return;
    const made = draftOf(form, target, accounts, catalogs);
    if ('problem' in made) {
      setProblem(made.problem);
      return;
    }
    setProblem(null);
    setSending(true);
    await onSend(made.draft);
    setSending(false);
  };
  // Ctrl+Enter sends from anywhere in the dialog, the description included.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <DialogContent
      aria-describedby={undefined}
      className="w-[min(640px,calc(100vw-48px))]"
      data-testid="send-to-linear"
      onKeyDown={onKeyDown}
    >
      <DialogHeader partNumber="LIN">
        <DialogTitle>{heading}</DialogTitle>
      </DialogHeader>
      <form aria-label={heading} onSubmit={send}>
        <DialogBody className="flex flex-col gap-3.5">
          {usable.length === 0 ? (
            <p className="m-0 text-row text-text">
              {accounts.length
                ? 'Commander doesn’t know your Linear teams yet. Try again once Linear has synced.'
                : 'No Linear Account connected yet. Connect one in Settings → Accounts (,).'}
            </p>
          ) : (
            <>
              <Field id="send-title" name="Title">
                <Input
                  id="send-title"
                  autoFocus
                  value={form.title}
                  maxLength={255}
                  aria-invalid={problem === 'An issue needs a title' || undefined}
                  onChange={(event) => set({ title: event.target.value })}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3.5">
                <Picker
                  id="send-workspace"
                  name="Workspace"
                  value={form.account ?? ''}
                  disabled={usable.length < 2}
                  onChange={(account) =>
                    onChange(
                      withTeam(
                        form,
                        account,
                        catalogs.get(account)?.teams[0]?.id ?? null,
                        accounts,
                        catalogs,
                      ),
                    )
                  }
                >
                  {usable.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name}
                    </SelectItem>
                  ))}
                </Picker>
                <Picker
                  id="send-team"
                  name="Team"
                  value={form.teamId ?? ''}
                  onChange={(teamId) => onChange(withTeam(form, form.account, teamId, accounts, catalogs))}
                >
                  {teams.map((each) => (
                    <SelectItem key={each.id} value={each.id}>
                      {each.key} · {each.name}
                    </SelectItem>
                  ))}
                </Picker>
                <Picker
                  id="send-assignee"
                  name="Assignee"
                  value={form.assigneeId ?? NONE}
                  onChange={(value) => set({ assigneeId: value === NONE ? null : value })}
                >
                  {people.map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.id === me ? `${person.name} (you)` : person.name}
                    </SelectItem>
                  ))}
                  <SelectItem value={NONE}>Unassigned</SelectItem>
                </Picker>
                <Picker
                  id="send-state"
                  name="State"
                  value={form.stateId ?? ''}
                  onChange={(stateId) => set({ stateId })}
                >
                  {(team?.states ?? []).map((state) => (
                    <SelectItem key={state.id} value={state.id}>
                      {state.name}
                    </SelectItem>
                  ))}
                </Picker>
                <Picker
                  id="send-priority"
                  name="Priority"
                  value={String(form.priority)}
                  onChange={(value) => set({ priority: Number(value) })}
                >
                  {PRIORITY_NAMES.map((name, priority) => (
                    <SelectItem key={name} value={String(priority)}>
                      {name}
                    </SelectItem>
                  ))}
                </Picker>
              </div>
              <Field id="send-description" name="Description (optional)">
                <textarea
                  id="send-description"
                  rows={4}
                  value={form.description}
                  onChange={(event) => set({ description: event.target.value })}
                  className={cn(inputVariants(), 'h-auto resize-y py-1.5 leading-[1.45]')}
                />
              </Field>
              <p className="m-0 text-note text-muted">
                The description is sent once, when the issue is made. After that it’s read-only here, as for
                every issue: edit it in Linear.
              </p>
            </>
          )}
          {problem && (
            <p role="alert" className="m-0 text-note text-signal-ink">
              {problem}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={sending || usable.length === 0}>
            Send to Linear <Kbd>Ctrl ↵</Kbd>
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
