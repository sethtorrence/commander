import { randomBytes } from 'node:crypto';
import {
  type ComposeMode,
  type EmailBody,
  type EmailDetail,
  emailReaderUrlOf,
  quotedHtml,
  quotedText,
  textAsHtml,
} from '@commander/domain';
import { JSDOM } from 'jsdom';
import type { Sanitise } from '../email-reader/sanitiser';

// The quoted history below a reply, or the message a forward carries (#138). The original is outside
// material (ADR 0004): its HTML goes into the message only as the email reader's sanitiser cleaned it
// (no scripts, handlers, frames, forms or anything else that runs), with its remote images pointing
// back at their own addresses (it is the recipients' mail client that shows them, never Commander's
// window) and its inline images left out. A message too complex to clean in time is quoted as text.

/** The quote for a reply to (or forward of) `original`, in HTML and plain text. */
export async function quoteOf(
  original: Pick<EmailDetail, 'from' | 'sentAt' | 'subject' | 'to' | 'cc'>,
  body: EmailBody | null,
  mode: ComposeMode,
  sanitise: Sanitise,
): Promise<{ html: string; text: string }> {
  const text = body?.text ?? '';
  let inner = textAsHtml(text);
  if (body?.html) {
    try {
      const token = randomBytes(16).toString('hex');
      const cleaned = await sanitise({ html: body.html, images: 'shown', quotes: true, token });
      const { document } = new JSDOM(cleaned.html).window;
      for (const image of [...document.querySelectorAll('img')]) {
        const named = emailReaderUrlOf(image.getAttribute('src') ?? '');
        const remote = named?.kind === 'image' ? cleaned.remoteImages[named.index] : undefined;
        if (remote && /^https?:\/\//i.test(remote)) image.setAttribute('src', remote);
        else image.remove();
      }
      inner = document.body.innerHTML;
    } catch {
      // Too complex to clean in time: quoted as its text.
    }
  }
  return { html: quotedHtml(original, inner, mode), text: quotedText(original, text, mode) };
}
