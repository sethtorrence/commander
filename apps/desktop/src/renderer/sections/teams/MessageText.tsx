import { cn } from '@commander/ui';
import type { ReactNode } from 'react';
import { type MessagePart, messageParts } from './chats';

/*
  A Chat message's text, shown safely (ADR 0004: Source text is untrusted). Teams sync keeps message
  text as plain text, converted from Teams' HTML, and this never treats it as anything else: it is
  built from React text nodes only (no innerHTML), so markup in it shows as the characters it is.
  Web and mail addresses become links, which the window hands to the system browser (its
  new-window handler lets only web and mail links out); nothing else ever does. An inline image is
  never loaded (Teams images need signing in anyway): "[image]" shows instead, with Open in Teams.
  Mentions of the User are highlighted. Paragraphs and line breaks are kept.
*/

const isWebAddress = (url: string | null): url is string => !!url && /^https?:\/\//i.test(url);

const linkClass =
  'text-ink underline decoration-line underline-offset-2 [overflow-wrap:anywhere] hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal';

/** A link out of Commander, to the system browser (through the window's new-window handler). */
export function OutLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={className ?? linkClass}>
      {children}
    </a>
  );
}

function Part({ part, webUrl }: { part: MessagePart; webUrl: string | null }) {
  switch (part.kind) {
    case 'text':
      return part.text;
    case 'link':
      return <OutLink href={part.href}>{part.text}</OutLink>;
    case 'mention':
      return (
        <mark className="bg-raise px-0.5 font-semibold text-ink shadow-[inset_0_-2px_0_var(--ink)]">
          {part.text}
        </mark>
      );
    case 'image':
      return (
        <span className="inline-flex items-baseline gap-1.5">
          <span className="border border-dashed border-line px-1 font-mono text-label-lg text-muted">
            [image]
          </span>
          {isWebAddress(webUrl) && (
            <OutLink
              href={webUrl}
              className={cn(linkClass, 'font-mono text-label-lg uppercase tracking-label')}
            >
              Open in Teams ↗
            </OutLink>
          )}
        </span>
      );
  }
}

export function MessageText({
  text,
  mentions,
  webUrl,
  className,
}: {
  /** The message's plain text. */
  text: string;
  /** The names it mentions the User by, to highlight. */
  mentions: readonly string[];
  /** The Chat in Teams, for Open in Teams beside an image (only if it is a web address). */
  webUrl: string | null;
  className?: string;
}) {
  const paragraphs = text.trim().split(/\n\s*\n/);
  return (
    <div data-slot="message-text" className={cn('[overflow-wrap:anywhere]', className)}>
      {paragraphs.map((paragraph, p) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs have no identity beyond their place
        <p key={p} className="my-0 mb-2 last:mb-0">
          {paragraph.split('\n').flatMap((line, l) => [
            // biome-ignore lint/suspicious/noArrayIndexKey: line breaks have no identity beyond their place
            ...(l ? [<br key={`br${l}`} />] : []),
            ...messageParts(line, mentions).map((part, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a line's parts have no identity beyond their place
              <Part key={`${l}.${i}`} part={part} webUrl={webUrl} />
            )),
          ])}
        </p>
      ))}
    </div>
  );
}
