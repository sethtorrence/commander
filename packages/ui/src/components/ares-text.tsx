import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

/*
  AresText (#69): how anything a model wrote is shown. Plain text with light formatting (bold,
  italic, code, line breaks, paragraphs, bullet lists), built as React text nodes, so nothing a
  model writes ever becomes markup. It loads no images (an image becomes "[image: …]") and makes no
  requests. A URL is clickable only if that exact URL appears in the source Items the text was made
  from (`sources`); any other shows as plain text, with a Markdown link's address beside its words.
  Clicking a link opens it in the system browser through the window's new-window handler, like
  every link in the window. This closes the "image or link that leaks data" trick (#22).
  An Item the text names by its ref ([I1], #192) is a link only when the caller gives that ref (the
  Items Ares was handed for that answer), and opens the Item in Commander, never anything outside.
*/

const URL = /\bhttps?:\/\/[^\s<>"'`[\]()“”‘’«»]+/gi;
const TRAILING = /[.,;:!?'"]+$/;

/** The web addresses in a text, without trailing punctuation: what a source makes clickable. */
export function urlsIn(text: string): string[] {
  return [...text.matchAll(URL)].map((match) => match[0].replace(TRAILING, ''));
}

const TOKEN =
  /(?<image>!\[(?<alt>[^[\]\n]{0,500})\]\([^()\s]{0,2000}\))|(?<link>\[(?<label>[^[\]\n]{1,500})\]\((?<href>[^()\s]{1,2000})\))|(?<ref>\[(?<refId>I[1-9]\d{0,2})\])|(?<url>\bhttps?:\/\/[^\s<>"'`[\]()“”‘’«»]+)|(?<code>`(?<codeText>[^`\n]+)`)|(?<bold>\*\*(?<boldText>[^*\n]+)\*\*)|(?<em>(?<![\w*])[*_](?<emText>[^*_\n]+?)[*_](?![\w*]))/gi;

/**
 * An Item a text names by its ref ([I1], #192): what its link says, how it is announced, and what
 * opening it does (its Item, in its Section). Only refs given here become links.
 */
export type AresTextRef = { text: string; label: string; onOpen: () => void };

const refClass =
  'mx-0.5 inline cursor-pointer border border-line bg-raise px-1 py-0 align-baseline font-mono text-[0.82em] leading-[1.4] text-ink hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal';

const linkClass =
  'text-ink underline decoration-line underline-offset-2 hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal';

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={linkClass}>
      {children}
    </a>
  );
}

type Refs = ReadonlyMap<string, AresTextRef>;

function inline(text: string, allowed: ReadonlySet<string>, key: string, refs: Refs): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > at) out.push(text.slice(at, index));
    at = index + match[0].length;
    const groups = match.groups ?? {};
    const k = `${key}.${index}`;
    if (groups.ref !== undefined) {
      const ref = refs.get(groups.refId?.toUpperCase() ?? '');
      out.push(
        ref ? (
          <button key={k} type="button" className={refClass} aria-label={ref.label} onClick={ref.onOpen}>
            {ref.text}
          </button>
        ) : (
          match[0]
        ),
      );
    } else if (groups.image !== undefined) {
      out.push(groups.alt?.trim() ? `[image: ${groups.alt.trim()}]` : '[image]');
    } else if (groups.link !== undefined) {
      const href = groups.href ?? '';
      if (/^https?:\/\//i.test(href) && allowed.has(href)) {
        out.push(
          <Link key={k} href={href}>
            {groups.label}
          </Link>,
        );
      } else out.push(`${groups.label} (${href})`);
    } else if (groups.url !== undefined) {
      const url = groups.url.replace(TRAILING, '');
      out.push(
        allowed.has(url) ? (
          <Link key={k} href={url}>
            {url}
          </Link>
        ) : (
          url
        ),
      );
      out.push(groups.url.slice(url.length));
    } else if (groups.code !== undefined) {
      out.push(
        <code key={k} className="border border-line2 bg-raise px-1 font-mono text-[0.88em]">
          {groups.codeText}
        </code>,
      );
    } else if (groups.bold !== undefined) {
      out.push(<strong key={k}>{groups.boldText}</strong>);
    } else if (groups.em !== undefined) {
      out.push(<em key={k}>{groups.emText}</em>);
    }
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

const BULLET = /^\s*[-*•]\s+/;

function blocks(text: string, allowed: ReadonlySet<string>, refs: Refs): ReactNode[] {
  const out: ReactNode[] = [];
  text
    .trim()
    .split(/\n\s*\n/)
    .forEach((paragraph, p) => {
      // Runs of bullet lines become lists; other runs, paragraphs with line breaks.
      const runs: { bullets: boolean; lines: string[] }[] = [];
      for (const line of paragraph.split('\n')) {
        const bullets = BULLET.test(line);
        const last = runs.at(-1);
        if (last && last.bullets === bullets) last.lines.push(line);
        else runs.push({ bullets, lines: [line] });
      }
      runs.forEach((run, r) => {
        const key = `${p}.${r}`;
        if (run.bullets) {
          out.push(
            <ul key={key} className="my-0 mb-2 list-disc pl-5 last:mb-0">
              {run.lines.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: list items have no identity beyond their place
                <li key={i}>{inline(line.replace(BULLET, ''), allowed, `${key}.${i}`, refs)}</li>
              ))}
            </ul>,
          );
        } else {
          out.push(
            <p key={key} className="my-0 mb-2 last:mb-0">
              {run.lines.flatMap((line, i) => [
                // biome-ignore lint/suspicious/noArrayIndexKey: line breaks have no identity beyond their place
                ...(i ? [<br key={`br${i}`} />] : []),
                ...inline(line, allowed, `${key}.${i}`, refs),
              ])}
            </p>,
          );
        }
      });
    });
  return out;
}

export interface AresTextProps {
  /** What the model wrote. */
  text: string;
  /** The text of the source Items it was made from: only URLs in these are clickable. */
  sources?: readonly string[];
  /** Inline, in a span (line breaks become spaces), rather than as paragraphs. */
  inline?: boolean;
  /** The Items the text names by ref ([I1]), each a link that opens it; any other ref stays text. */
  refs?: ReadonlyMap<string, AresTextRef>;
  className?: string;
}

const NO_REFS: Refs = new Map();

/** Anything a model wrote, as plain text with light formatting. */
export function AresText({
  text,
  sources = [],
  inline: isInline = false,
  refs = NO_REFS,
  className,
}: AresTextProps) {
  const allowed = new Set(sources.flatMap(urlsIn));
  if (isInline) {
    return (
      <span data-slot="ares-text" className={className}>
        {inline(text.replace(/\s*\n\s*/g, ' '), allowed, 'i', refs)}
      </span>
    );
  }
  return (
    <div data-slot="ares-text" className={cn('[overflow-wrap:anywhere]', className)}>
      {blocks(text, allowed, refs)}
    </div>
  );
}
