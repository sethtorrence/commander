import type { EmailView } from '@commander/domain';
import { toast } from '@commander/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EmailReaderClient } from './reader';

/*
  One message's HTML, as its sender designed it, safely (#134). The main process has the Core sanitise
  it and serves it from commander-mail: into this frame, which is sandboxed with nothing but popups
  allowed: no scripts, no same-origin, no forms, no top-level navigation. Its links open new windows,
  which the main process hands to the system browser (web and mail links only); the frame itself never
  navigates. It sits on a light sheet whatever the theme, sized to its content (the main process lays
  the same document out out of sight, scripts off, and reports its height). The real destination of a
  hovered link shows at the foot of the thread (LinkTarget).

  Remote images follow the message's image rule: when they are held back, a bar offers Show images
  (this message) and Always show from this sender. Quoted history is folded behind "…".
*/

export const FRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';
// Until it is measured, the frame scrolls within this height.
const FIRST_HEIGHT = 240;
const barClass =
  'flex flex-wrap items-center gap-x-3 gap-y-1.5 border border-line bg-raise px-3 py-2 font-mono text-label leading-tight uppercase tracking-label text-muted';
const barButton =
  'cursor-pointer border border-line bg-sheet px-2 py-1 font-mono text-label leading-none font-semibold uppercase tracking-caps text-ink hover:bg-raise';

export function EmailFrame({
  itemId,
  subject,
  reader,
  onUnavailable,
}: {
  itemId: string;
  subject: string;
  reader: EmailReaderClient;
  /** The message has no HTML to show after all (or it couldn't be prepared): show its text. */
  onUnavailable: () => void;
}) {
  const [quotes, setQuotes] = useState(false);
  const [version, setVersion] = useState(0);
  const [view, setView] = useState<EmailView | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks again after an image rule changed
  useEffect(() => {
    let live = true;
    reader.open(itemId, quotes).then(
      (opened) => {
        if (!live) return;
        if (opened) {
          setView(opened);
          setHeight(null);
        } else unavailable.current();
      },
      () => live && unavailable.current(),
    );
    return () => {
      live = false;
    };
  }, [reader, itemId, quotes, version]);

  // Sized to its content at its width, measured again when the width changes.
  useEffect(() => {
    const element = box.current;
    if (!view || !element) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastWidth = 0;
    const measure = () => {
      const width = Math.round(element.clientWidth);
      if (width < 80 || width === lastWidth) return;
      lastWidth = width;
      reader.measure(view.url, width).then((measured) => {
        if (live && measured !== null) setHeight(measured);
      });
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(measure, 150);
          });
    observer?.observe(element);
    return () => {
      live = false;
      clearTimeout(timer);
      observer?.disconnect();
    };
  }, [reader, view]);

  const change = useCallback(async (action: () => Promise<void>) => {
    try {
      await action();
      setVersion((value) => value + 1);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  }, []);

  if (!view) return <p className="mt-4 text-note text-faint">Opening the message…</p>;
  return (
    <div className="mt-4 mb-2" data-testid="email-html">
      {view.images === 'held' && (
        <section className={barClass} data-testid="email-images-bar" aria-label="Images">
          <span>
            {view.imageCount} {view.imageCount === 1 ? 'image' : 'images'} held back
          </span>
          <button
            type="button"
            className={barButton}
            onClick={() => void change(() => reader.showImages(itemId))}
          >
            Show images
          </button>
          {view.sender && (
            <button
              type="button"
              className={barButton}
              onClick={() => void change(() => reader.trustSender(itemId))}
            >
              Always show from this sender
            </button>
          )}
        </section>
      )}
      <div ref={box} className="border border-line bg-white">
        <iframe
          key={view.url}
          title={`Message: ${subject}`}
          data-testid="email-frame"
          src={view.url}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          className="block w-full border-0 bg-white"
          style={{ height: height ?? FIRST_HEIGHT, colorScheme: 'light' }}
        />
      </div>
      {view.hasQuote && (
        <button
          type="button"
          aria-label={quotes ? 'Hide quoted text' : 'Show quoted text'}
          aria-expanded={quotes}
          onClick={() => setQuotes((value) => !value)}
          className={barButton}
        >
          …
        </button>
      )}
    </div>
  );
}
