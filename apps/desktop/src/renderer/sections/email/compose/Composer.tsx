import {
  attachmentSize,
  attachmentsProblem,
  type ComposeAttachment,
  type ComposeBody,
  type ComposeState,
  isBodyEmpty,
  settleAresLink,
  unkeptLinks,
} from '@commander/domain';
import { Button, cn, Kbd, toast } from '@commander/ui';
import { type DragEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { type EmailAccountSummary, emailAddressOf } from '../email';
import { AddressField } from './AddressField';
import { type ComposeClient, draftOf } from './compose';
import { RichEditor } from './RichEditor';

/*
  The composer (#138): From (replies and forwards from the Account the message arrived at; new mail from
  the default Account, changeable), To, Cc and Bcc with suggestions, Subject, the body with simple
  formatting and the signature, attachments (by the Attach button or dropped, each with its size, up to
  35 MB together), and a reply's quoted history folded below, as text. After a pause in typing the
  draft is saved (to Gmail's or Outlook's Drafts too). Send (Ctrl+Enter) hands it to the Core, which
  holds it for the Undo time; Discard throws the draft away. It never shows anyone's HTML.

  Opened from Ares's suggested reply (#143), it is an ordinary draft. A link he added that is in neither
  the thread nor the User's sent mail stays marked "Ares added this link", with Keep and Remove: until
  kept it is left out of the draft Gmail or Outlook holds, and Send asks the User to decide first.
*/

// The pause in typing after which the draft is saved.
export const SAVE_PAUSE_MS = 1_500;

const labelClass = 'font-mono text-label leading-none font-semibold uppercase tracking-caps';

export type SentMessage = { itemId: string; sendAt: number; state: ComposeState };

export function Composer({
  client,
  initial,
  accounts,
  placement,
  onClose,
  onSent,
  onSaveBeforeQuit,
  onState,
}: {
  client: ComposeClient;
  initial: ComposeState;
  /** The email Accounts, for From. */
  accounts: EmailAccountSummary[];
  /** Beside the thread (a reply) or a sheet of its own (new mail). */
  placement: 'inline' | 'sheet';
  onClose: () => void;
  onSent: (sent: SentMessage) => void;
  /** Saves what it holds when Commander quits (the window's bridge). */
  onSaveBeforeQuit?: (save: () => Promise<void>) => () => void;
  /** Hears what it holds as it changes. */
  onState?: (state: ComposeState) => void;
}) {
  const [state, setState] = useState<ComposeState>(initial);
  const [showCc, setShowCc] = useState(initial.cc.length > 0 || initial.bcc.length > 0);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>(initial.itemId ? 'saved' : 'idle');
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  // Bumped to draw the body again (From changed: the new Account's signature).
  const [editorKey, setEditorKey] = useState(0);
  const latest = useRef(state);
  latest.current = state;
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const done = useRef(false);
  const picker = useRef<HTMLInputElement>(null);

  // Saves what the composer holds now, after any save under way.
  const save = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    while (inFlight.current) await inFlight.current;
    if (!dirty.current || done.current) return;
    dirty.current = false;
    const draft = draftOf(latest.current);
    setSaving('saving');
    const job = client.save(draft).then(
      ({ itemId }) => {
        if (!latest.current.itemId) setState((current) => ({ ...current, itemId }));
        latest.current = { ...latest.current, itemId };
        setSaving('saved');
      },
      (error: unknown) => {
        dirty.current = true;
        setSaving('idle');
        setProblem(error instanceof Error ? error.message : String(error));
      },
    );
    inFlight.current = job.finally(() => {
      inFlight.current = null;
    });
    await inFlight.current;
  }, [client]);

  const change = (next: Partial<ComposeState>) => {
    setState((current) => {
      const updated = { ...current, ...next };
      latest.current = updated;
      return updated;
    });
    dirty.current = true;
    setProblem(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_PAUSE_MS);
  };

  useEffect(() => onSaveBeforeQuit?.(save), [onSaveBeforeQuit, save]);
  // What it holds, for whoever shows it next (the thread closed: the reply moves to a sheet).
  useEffect(() => onState?.(state), [onState, state]);
  // Going away (moved, or the Section left): what was typed since the last save is saved.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (dirty.current && !done.current) void save();
    },
    [save],
  );

  const close = async () => {
    await save();
    done.current = true;
    onClose();
  };

  const discard = async () => {
    done.current = true;
    if (timer.current) clearTimeout(timer.current);
    while (inFlight.current) await inFlight.current;
    const itemId = latest.current.itemId;
    try {
      if (itemId) await client.discard(itemId);
      onClose();
      toast('Draft discarded');
    } catch (error) {
      done.current = false;
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  // Keep or Remove on a link Ares added: the body is drawn again with it settled.
  const settleLink = (link: string, keep: boolean) => {
    change({ body: settleAresLink(latest.current.body, link, keep) });
    setEditorKey((key) => key + 1);
  };

  const send = async () => {
    const current = latest.current;
    if (!current.to.length && !current.cc.length && !current.bcc.length) {
      setProblem('Add someone to send this to.');
      return;
    }
    if (unkeptLinks(current.body).length) {
      setProblem('Keep or remove the link Ares added first: it isn’t sent unless you keep it.');
      return;
    }
    const tooLarge = attachmentsProblem(current.attachments);
    if (tooLarge) {
      setProblem(tooLarge);
      return;
    }
    if (attaching) {
      setProblem('Wait for the attachments to finish adding.');
      return;
    }
    setSending(true);
    if (timer.current) clearTimeout(timer.current);
    while (inFlight.current) await inFlight.current;
    done.current = true;
    try {
      const sent = await client.send(draftOf(latest.current));
      onSent({ ...sent, state: { ...latest.current, itemId: sent.itemId } });
    } catch (error) {
      done.current = false;
      setSending(false);
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  const attach = async (files: readonly File[]) => {
    const planned = [...latest.current.attachments, ...files.map((file) => ({ size: file.size }))];
    const tooLarge = attachmentsProblem(planned);
    if (tooLarge) {
      setProblem(tooLarge);
      toast(tooLarge);
      return;
    }
    setAttaching((count) => count + files.length);
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const added = await client.attach({ name: file.name || 'attachment', type: file.type, bytes });
        change({ attachments: [...latest.current.attachments, added] });
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error));
      } finally {
        setAttaching((count) => count - 1);
      }
    }
  };

  const remove = (attachment: ComposeAttachment) =>
    change({ attachments: latest.current.attachments.filter((each) => each.id !== attachment.id) });

  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    void attach([...event.dataTransfer.files]);
  };

  // From: a reply's Account is the one the message arrived at; new mail may go from another, starting
  // its draft again there.
  const changeFrom = async (account: string) => {
    if (account === state.account) return;
    const itemId = latest.current.itemId;
    done.current = true;
    if (timer.current) clearTimeout(timer.current);
    while (inFlight.current) await inFlight.current;
    try {
      if (itemId) await client.discard(itemId);
      const fresh = await client.open('new', undefined, account);
      done.current = false;
      const kept = latest.current;
      const body = isBodyEmpty(kept.body) ? fresh.body : kept.body;
      setState({
        ...fresh,
        to: kept.to,
        cc: kept.cc,
        bcc: kept.bcc,
        subject: kept.subject,
        body,
        attachments: kept.attachments,
      });
      latest.current = {
        ...fresh,
        to: kept.to,
        cc: kept.cc,
        bcc: kept.bcc,
        subject: kept.subject,
        body,
        attachments: kept.attachments,
      };
      dirty.current = true;
      setEditorKey((key) => key + 1);
    } catch (error) {
      done.current = false;
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      void send();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      void close();
    }
  };

  const title =
    state.mode === 'new'
      ? 'New message'
      : state.mode === 'forward'
        ? 'Forward'
        : state.mode === 'reply-all'
          ? 'Reply all'
          : 'Reply';
  const total = state.attachments.reduce((sum, each) => sum + each.size, 0);

  return (
    <section
      aria-label={title}
      data-testid="composer"
      data-placement={placement}
      onKeyDown={onKeyDown}
      onDrop={onDrop}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      className={cn(
        'flex flex-col border border-ink bg-sheet text-ink',
        placement === 'sheet'
          ? 'fixed right-6 bottom-6 z-40 h-[min(640px,calc(100vh-96px))] w-[min(640px,calc(100vw-48px))] shadow-2xl'
          : 'mt-6',
      )}
    >
      <header className="flex h-9 flex-none items-center gap-3 border-b border-ink bg-ink pr-1 pl-4 text-sheet">
        <span className={cn(labelClass, 'text-sheet')}>{title}</span>
        <span
          className={cn(labelClass, 'ml-auto text-[9px] opacity-70')}
          role="status"
          data-testid="compose-saved"
        >
          {saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'Draft saved' : ''}
        </span>
        <button
          type="button"
          aria-label="Close (the draft is kept)"
          title="Close (Esc): the draft is kept"
          onClick={() => void close()}
          className="h-7 w-7 cursor-pointer border-0 bg-transparent text-sheet hover:bg-[color-mix(in_srgb,var(--sheet)_15%,transparent)]"
        >
          ×
        </button>
      </header>
      <div className="flex min-h-9 items-center border-b border-line2">
        <span className={cn(labelClass, 'w-[52px] flex-none pl-4 text-muted')}>From</span>
        {state.mode === 'new' && accounts.length > 1 ? (
          <select
            aria-label="From"
            value={state.account}
            onChange={(event) => void changeFrom(event.target.value)}
            className="h-7 min-w-0 flex-1 border-0 bg-transparent text-note text-ink outline-none"
          >
            {accounts.map((each) => (
              <option key={each.id} value={each.id}>
                {emailAddressOf(each)}
              </option>
            ))}
          </select>
        ) : (
          <span data-testid="compose-from" className="min-w-0 flex-1 truncate text-note text-ink">
            {state.from.name ? `${state.from.name} <${state.from.address}>` : state.from.address}
          </span>
        )}
        {!showCc && (
          <button
            type="button"
            onClick={() => setShowCc(true)}
            className={cn(
              labelClass,
              'mr-3 cursor-pointer border-0 bg-transparent text-muted hover:text-ink',
            )}
          >
            Cc Bcc
          </button>
        )}
      </div>
      <AddressField
        label="To"
        addresses={state.to}
        onChange={(to) => change({ to })}
        suggest={client.suggest}
        autoFocus={state.mode === 'new' || state.mode === 'forward'}
      />
      {showCc && (
        <>
          <AddressField
            label="Cc"
            addresses={state.cc}
            onChange={(cc) => change({ cc })}
            suggest={client.suggest}
          />
          <AddressField
            label="Bcc"
            addresses={state.bcc}
            onChange={(bcc) => change({ bcc })}
            suggest={client.suggest}
          />
        </>
      )}
      <div className="flex min-h-9 items-center border-b border-line2">
        <label htmlFor="compose-subject" className={cn(labelClass, 'w-[52px] flex-none pl-4 text-muted')}>
          Subj
        </label>
        <input
          id="compose-subject"
          aria-label="Subject"
          value={state.subject}
          onChange={(event) => change({ subject: event.target.value })}
          className="h-8 min-w-0 flex-1 border-0 bg-transparent pr-3 text-note font-semibold text-ink outline-none"
        />
      </div>
      <RichEditor
        key={editorKey}
        initial={state.body}
        label="Message"
        autoFocus={state.mode === 'reply' || state.mode === 'reply-all'}
        onChange={(body: ComposeBody) => change({ body })}
        onFiles={(files) => void attach(files)}
        className={placement === 'sheet' ? 'flex-1' : ''}
      />
      {unkeptLinks(state.body).length > 0 && (
        <ul
          aria-label="Links Ares added"
          className="m-0 list-none border-t border-line2 bg-signal-focus px-4 py-1"
          data-testid="compose-ares-links"
        >
          {unkeptLinks(state.body).map((link) => (
            <li key={link} className="flex items-center gap-3 py-1">
              <span className="min-w-0 flex-1 text-note text-ink">
                <b className="font-mono text-label font-semibold uppercase tracking-label">
                  Ares added this link
                </b>{' '}
                <span className="break-all font-mono text-label">{link}</span>
                <span className="text-muted">
                  {' '}
                  · in neither the thread nor your sent mail, so it isn’t sent unless you keep it
                </span>
              </span>
              <Button aria-label={`Keep ${link}`} onClick={() => settleLink(link, true)}>
                Keep
              </Button>
              <Button aria-label={`Remove ${link}`} onClick={() => settleLink(link, false)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {state.quote !== null && (
        <div className="border-t border-line2 px-4 py-2">
          <button
            type="button"
            aria-expanded={quoteOpen}
            aria-label={quoteOpen ? 'Hide quoted text' : 'Show quoted text'}
            onClick={() => setQuoteOpen((open) => !open)}
            className="cursor-pointer border border-line bg-sheet px-2 py-0.5 font-mono text-label leading-none text-ink hover:bg-raise"
          >
            …
          </button>
          {quoteOpen && (
            <pre
              data-testid="compose-quote"
              className="mt-2 max-h-56 overflow-y-auto font-sans text-note leading-[1.5] whitespace-pre-wrap text-muted"
            >
              {state.quote}
            </pre>
          )}
        </div>
      )}
      {(state.attachments.length > 0 || attaching > 0) && (
        <ul aria-label="Attachments" className="m-0 list-none border-t border-line2 px-4 py-1">
          {state.attachments.map((attachment) => (
            <li key={attachment.id} data-testid="compose-attachment" className="flex items-center gap-3 py-1">
              <span className="min-w-0 flex-1 truncate text-note text-ink">{attachment.name}</span>
              <span className="flex-none font-mono text-label text-muted">
                {attachmentSize(attachment.size)}
              </span>
              <button
                type="button"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => remove(attachment)}
                className="cursor-pointer border-0 bg-transparent px-1 text-muted hover:text-ink"
              >
                ×
              </button>
            </li>
          ))}
          {attaching > 0 && <li className="py-1 text-note text-faint">Adding {attaching}…</li>}
          {state.attachments.length > 1 && (
            <li className="py-1 font-mono text-label text-muted">
              Together {attachmentSize(total)} of 35 MB
            </li>
          )}
        </ul>
      )}
      {problem && (
        <p role="alert" className="m-0 border-t border-line2 px-4 py-2 text-note font-semibold text-ink">
          {problem}
        </p>
      )}
      <footer className="flex flex-none items-center gap-2 border-t border-line px-3 py-2">
        <Button variant="primary" disabled={sending} onClick={() => void send()}>
          Send
        </Button>
        <span className="font-mono text-label text-faint">
          <Kbd>Ctrl</Kbd> <Kbd>↵</Kbd>
        </span>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-label="Attach files"
          data-testid="compose-attach-input"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = '';
            if (files.length) void attach(files);
          }}
        />
        <Button onClick={() => picker.current?.click()}>Attach</Button>
        <span className="ml-auto" />
        <Button aria-label="Discard draft" onClick={() => void discard()}>
          Discard
        </Button>
      </footer>
    </section>
  );
}
