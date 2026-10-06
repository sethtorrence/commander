import {
  addressName,
  type EmailAddress,
  type EmailAttachment,
  type EmailBody,
  type EmailDetail,
  type EmailThread,
  type EmailThreadSummary,
  type Item,
  isOpenableAttachment,
} from '@commander/domain';
import { cn, Kbd, toast } from '@commander/ui';
import { type ReactNode, useEffect, useState } from 'react';
import { useNow } from '../../frame/use-now';
import { ItemWarning } from '../../links/ItemWarning';
import { EmailFrame } from './EmailFrame';
import { sentTime, threadTime } from './email';
import type { EmailReaderClient } from './reader';
import { expandedAtFirst, fileSize, splitQuote, textPieces } from './thread-view';

/*
  The open thread (#134): its subject, then its messages in order. Older read messages are collapsed
  to a line (sender, snippet, time) and the newest and unread ones expanded, each with its headers,
  its body and its attachments. A message with HTML shows it in the sandboxed frame (EmailFrame); a
  plain-text one as text, with web and mail addresses as links. Quoted history folds behind "…".
*/

const fullAddress = (address: EmailAddress) =>
  address.name?.trim() ? `${address.name.trim()} <${address.address}>` : address.address;
const addresses = (list: EmailAddress[]) => list.map(fullAddress).join(', ');

const linkClass =
  'text-ink underline decoration-line underline-offset-2 [overflow-wrap:anywhere] hover:decoration-ink';
const smallButton =
  'cursor-pointer border border-line bg-sheet px-2 py-1 font-mono text-label leading-none font-semibold uppercase tracking-caps text-ink hover:bg-raise';

function HeaderRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2.5 border-b border-line2 py-1.5 font-mono text-label leading-[1.4] tracking-label">
      <dt className="uppercase text-muted">{label}</dt>
      <dd className="m-0 font-semibold break-words text-ink">{children}</dd>
    </div>
  );
}

/** Plain text, never markup: built from text nodes, with web and mail addresses as links out. */
function Text({ text }: { text: string }) {
  return (
    <>
      {textPieces(text).map((piece, index) =>
        piece.href ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a text's pieces have no identity beyond their place
          <a key={index} href={piece.href} target="_blank" rel="noreferrer noopener" className={linkClass}>
            {piece.text}
          </a>
        ) : (
          piece.text
        ),
      )}
    </>
  );
}

function TextBody({ body }: { body: EmailBody | null }) {
  const [quoted, setQuoted] = useState(false);
  if (!body) return <p className="mt-4 text-note text-faint">No text was kept for this message.</p>;
  const { body: text, quote } = splitQuote(body.text);
  return (
    <>
      <div
        data-testid="email-body"
        className="mt-4 text-[15px] leading-[1.6] break-words whitespace-pre-wrap text-text"
      >
        <Text text={quote && !quoted ? text : body.text} />
      </div>
      {quote && (
        <button
          type="button"
          aria-label={quoted ? 'Hide quoted text' : 'Show quoted text'}
          aria-expanded={quoted}
          onClick={() => setQuoted((value) => !value)}
          className={cn(smallButton, 'mt-2')}
        >
          …
        </button>
      )}
    </>
  );
}

function Attachments({
  itemId,
  attachments,
  reader,
}: {
  itemId: string;
  attachments: EmailAttachment[];
  reader: EmailReaderClient;
}) {
  const listed = attachments.filter((each) => !each.inline);
  if (!listed.length) return null;
  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <ul aria-label="Attachments" className="m-0 mt-4 list-none border-t border-line2 p-0">
      {listed.map((attachment) => (
        <li
          key={attachment.partId}
          data-testid="email-attachment"
          className="flex items-center gap-3 border-b border-line2 py-1.5"
        >
          <span className="min-w-0 flex-1 truncate text-row text-ink">{attachment.name}</span>
          <span className="flex-none font-mono text-label uppercase tracking-label text-muted">
            {attachment.type} · {fileSize(attachment.size)}
          </span>
          <button
            type="button"
            className={smallButton}
            aria-label={`Save ${attachment.name}`}
            onClick={() =>
              void run(async () => {
                if (await reader.saveAttachment(itemId, attachment.partId)) toast(`Saved ${attachment.name}`);
              })
            }
          >
            Save…
          </button>
          {isOpenableAttachment(attachment.name, attachment.type) && (
            <button
              type="button"
              className={smallButton}
              aria-label={`Open ${attachment.name}`}
              onClick={() => void run(() => reader.openAttachment(itemId, attachment.partId))}
            >
              Open
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function Message({
  item,
  body,
  reader,
  note,
}: {
  item: Item;
  body: EmailBody | null;
  reader: EmailReaderClient;
  /** How the message stands, when it is one of the User's on its way (#138). */
  note?: ReactNode;
}) {
  const detail = item.detail as EmailDetail;
  const [asText, setAsText] = useState(!body?.html);
  useEffect(() => setAsText(!body?.html), [body?.html]);
  return (
    <article data-testid="email-message" data-expanded="true" className="mt-6 border-t border-line pt-1">
      <ItemWarning item={item} variant="pane" className="mt-2" />
      <dl className="m-0">
        <HeaderRow label="From">{detail.from ? fullAddress(detail.from) : '(unknown sender)'}</HeaderRow>
        {detail.to.length > 0 && <HeaderRow label="To">{addresses(detail.to)}</HeaderRow>}
        {detail.cc.length > 0 && <HeaderRow label="Cc">{addresses(detail.cc)}</HeaderRow>}
        <HeaderRow label="Date">{sentTime(detail.sentAt)}</HeaderRow>
      </dl>
      {asText ? (
        <TextBody body={body} />
      ) : (
        <EmailFrame
          itemId={item.id}
          subject={detail.subject || item.title}
          reader={reader}
          onUnavailable={() => setAsText(true)}
        />
      )}
      {body?.truncated && !body.html && (
        <p className="mt-2 text-note text-faint">
          This message is long: the rest is in {item.source === 'outlook' ? 'Outlook' : 'Gmail'}.
        </p>
      )}
      {asText && body?.textFromHtml && (
        <p className="mt-2 font-mono text-label uppercase tracking-label text-faint">
          Shown as text · {addressName(detail.from)} sent HTML
        </p>
      )}
      {!note && <Attachments itemId={item.id} attachments={detail.attachments} reader={reader} />}
      {note}
    </article>
  );
}

function CollapsedMessage({ item, onExpand }: { item: Item; onExpand: () => void }) {
  const detail = item.detail as EmailDetail;
  const now = useNow(60_000);
  return (
    <article data-testid="email-message" data-expanded="false" className="mt-2 border-t border-line2">
      <button
        type="button"
        onClick={onExpand}
        aria-label={`Show the message from ${addressName(detail.from) || 'an unknown sender'}`}
        className="grid w-full cursor-pointer grid-cols-[minmax(0,180px)_minmax(0,1fr)_auto] items-baseline gap-3 border-0 bg-transparent py-2 text-left hover:bg-raise"
      >
        <span className="truncate text-row font-semibold text-ink">
          {detail.sentByMe ? 'me' : addressName(detail.from) || '(unknown sender)'}
        </span>
        <span className="truncate text-note text-muted">{detail.snippet}</span>
        <span className="font-mono text-label text-muted">{threadTime(detail.sentAt, now)}</span>
      </button>
    </article>
  );
}

/**
 * Where a hovered link really goes (anti-phishing): the main process reports the destination of the
 * link under the pointer, in an email's frame or not; one in Commander's own page is left to it, so
 * this shows only links in the emails. Like a browser's status bar, at the foot of the thread.
 */
function LinkTarget({ reader }: { reader: EmailReaderClient }) {
  const [target, setTarget] = useState('');
  useEffect(
    () => reader.onLinkHover((url) => setTarget(url && !document.querySelector('a:hover') ? url : '')),
    [reader],
  );
  return (
    <p
      data-testid="email-link-target"
      aria-live="polite"
      className={cn(
        'sticky bottom-0 z-[2] m-0 truncate border-t border-line bg-sheet px-10 py-1 font-mono text-label leading-5 tracking-label text-ink',
        !target && 'invisible',
      )}
    >
      {target ? `→ ${target}` : ''}
    </p>
  );
}

export function ThreadReader({
  thread,
  summary,
  accountName,
  reader,
  onClose,
  toolbar,
  footer,
  noteFor,
}: {
  thread: EmailThread | null;
  summary: EmailThreadSummary | null;
  accountName: (accountId: string) => string;
  reader: EmailReaderClient;
  onClose: () => void;
  /** The thread's actions (#135), in its header beside Close. */
  toolbar?: ReactNode;
  /** Below the messages: the reply being written (#138). */
  footer?: ReactNode;
  /** A message's note, for the User's own on their way (held for Undo, waiting, refused). */
  noteFor?: (item: Item) => ReactNode;
}) {
  const subject = summary?.subject || thread?.messages.at(-1)?.item.title || '';
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const threadKey = thread ? `${thread.account}\u0000${thread.threadKey}` : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: chosen afresh for each thread opened
  useEffect(() => {
    if (thread) setExpanded(expandedAtFirst(thread.messages));
  }, [threadKey]);
  const shown = (id: string) => expanded.has(id) || thread?.messages.at(-1)?.item.id === id;
  return (
    <section aria-label="Thread" className="min-w-0 border-l border-line">
      <div className="sticky top-0 z-[2] flex h-11 items-stretch border-b border-line bg-sheet">
        <button
          type="button"
          onClick={onClose}
          className="flex cursor-pointer items-center gap-2 border-0 border-r border-line2 bg-transparent px-3.5 font-mono text-label leading-none font-semibold uppercase tracking-caps text-ink hover:bg-raise"
        >
          <Kbd>Esc</Kbd> Close
        </button>
        {toolbar}
        {summary && (
          <span className="ml-auto flex min-w-0 shrink-[20] items-center truncate px-4 font-mono text-label leading-none uppercase tracking-caps whitespace-nowrap text-faint">
            {summary.messageCount} {summary.messageCount === 1 ? 'message' : 'messages'} ·{' '}
            {accountName(summary.account)}
          </span>
        )}
      </div>
      <div className="max-w-[820px] px-10 pt-5 pb-30">
        <h2 className="m-0 font-sans text-[26px] leading-[1.15] font-bold tracking-[-.015em] text-ink font-stretch-(--stretch-wide)">
          {subject || '(no subject)'}
        </h2>
        {!thread ? (
          <p className="mt-4 text-note text-faint">Reading the thread…</p>
        ) : (
          thread.messages.map(({ item, body }) =>
            shown(item.id) ? (
              <Message key={item.id} item={item} body={body} reader={reader} note={noteFor?.(item)} />
            ) : (
              <CollapsedMessage
                key={item.id}
                item={item}
                onExpand={() => setExpanded((open) => new Set([...open, item.id]))}
              />
            ),
          )
        )}
        {footer}
      </div>
      <LinkTarget reader={reader} />
    </section>
  );
}
