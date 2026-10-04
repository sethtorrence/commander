// The email reader in the main process (#134): the window's requests (ipc.emailReader), relayed to
// the Core and answered; the commander-mail: protocol serving prepared messages to the window's
// sandboxed frames; the remote images it fetches for them; the measurer that sizes the frames; the
// request and frame guards; and Save… / Open for attachments. See protocol.ts and guards.ts for the
// layers, and the domain's email-reader.ts for the URLs.
import { randomBytes } from 'node:crypto';
import { copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CoreEmailReaderReply,
  type CoreEmailRequest,
  coreEmailReaderReply,
  type EmailPart,
  type EmailReaderResponse,
  emailMessageUrl,
  emailReaderRequest,
  emailReaderScheme,
  emailReaderUrlOf,
  isOpenableAttachment,
} from '@commander/domain';
import { ipc } from '@commander/domain/ipc';
import { app, type BrowserWindow, dialog, ipcMain, protocol, session, shell } from 'electron';
import { guardEmailFrames, windowRequestAllowed } from './guards';
import { markFromInternet } from './internet-mark';
import { createMeasurer } from './measure';
import { type PreparedMessage, serveEmailReader } from './protocol';
import { createRemoteImages, fetchRemoteImage } from './remote-images';

type CoreResponse = CoreEmailReaderReply['response'];

// The Core sanitises (a large message takes a second or two) and may fetch a part from its Source.
const TIMEOUTS: Record<CoreEmailRequest['op'], number> = {
  render: 30_000,
  part: 120_000,
  'image-settings': 10_000,
  'show-images': 10_000,
  'trust-sender': 10_000,
  'untrust-sender': 10_000,
  'set-ask-first': 10_000,
};
// Prepared messages kept for their frames (a thread's worth, many times over).
const PREPARED_MAX = 64;

export function setUpEmailReader({
  window,
  send,
  testHooks = false,
}: {
  window: BrowserWindow;
  send: (message: unknown) => void;
  testHooks?: boolean;
}) {
  let nextId = 1;
  const pending = new Map<number, { resolve: (response: CoreResponse) => void; timer: NodeJS.Timeout }>();
  function ask(request: CoreEmailRequest): Promise<CoreResponse> {
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: 'The Core did not answer in time' });
      }, TIMEOUTS[request.op]);
      pending.set(id, { resolve, timer });
      send({ type: 'email-reader-request', id, request });
    });
  }

  const prepared = new Map<string, PreparedMessage>();
  const remember = (token: string, message: PreparedMessage) => {
    prepared.set(token, message);
    for (const old of prepared.keys()) {
      if (prepared.size <= PREPARED_MAX) break;
      prepared.delete(old);
    }
  };

  // End-to-end tests point remote images at a server on this machine, which is otherwise refused.
  const loopbackImages = testHooks && process.env.COMMANDER_TEST_REMOTE_IMAGES_LOOPBACK === '1';
  const remoteImages = createRemoteImages({
    fetch: (url) => fetchRemoteImage(url, loopbackImages ? { allowAddress: () => true } : {}),
  });
  async function part(
    itemId: string,
    request: { partId: string } | { contentId: string },
  ): Promise<EmailPart | null> {
    const response = await ask({ op: 'part', itemId, ...request });
    return response.ok && 'part' in response ? response.part : null;
  }
  const handler = (request: Request) =>
    serveEmailReader(request, {
      prepared: (token) => prepared.get(token) ?? null,
      remoteImage: (account, url) => remoteImages.get(account, url),
      part: (itemId, contentId) => part(itemId, { contentId }),
    });
  protocol.handle(emailReaderScheme, handler);
  const seen: { session: 'window' | 'measurer'; url: string; resourceType: string; allowed: boolean }[] = [];
  const measurer = createMeasurer(handler, (details, allowed) => {
    if (testHooks)
      seen.push({ session: 'measurer', url: details.url, resourceType: details.resourceType, allowed });
  });

  // The window's session: no web requests at all (but the development server's), and commander-mail:
  // only as its frames and their images. End-to-end tests read what it saw.
  const devOrigin = process.env.ELECTRON_RENDERER_URL
    ? new URL(process.env.ELECTRON_RENDERER_URL).origin
    : null;
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = windowRequestAllowed(details, {
      windowId: () => (window.isDestroyed() ? null : window.webContents.id),
      devOrigin,
    });
    if (testHooks && !details.url.startsWith('file:') && !details.url.startsWith('devtools:'))
      seen.push({ session: 'window', url: details.url, resourceType: details.resourceType, allowed });
    callback({ cancel: !allowed });
  });
  guardEmailFrames(window.webContents as never, (url) => {
    if (!window.isDestroyed()) window.webContents.send(ipc.emailLinkHover, url);
  });

  async function request(raw: unknown): Promise<EmailReaderResponse> {
    const parsed = emailReaderRequest.safeParse(raw);
    if (!parsed.success)
      return { ok: false, error: `Rejected email reader request: ${parsed.error.message}` };
    const asked = parsed.data;
    switch (asked.op) {
      case 'open': {
        const token = randomBytes(16).toString('hex');
        const response = await ask({ op: 'render', itemId: asked.itemId, quotes: asked.quotes, token });
        if (!response.ok) return response;
        if (!('render' in response)) return { ok: false, error: 'The Core sent an unexpected answer' };
        const { render } = response;
        remember(token, { itemId: asked.itemId, render });
        // Every image the message shows is fetched now, not when CSS asks for it (on hover, at some
        // width), so when and how it is read doesn't leak to the sender beyond its opening.
        if (render.images === 'shown')
          for (const url of render.remoteImages) void remoteImages.get(render.account, url);
        return {
          ok: true,
          view: {
            url: emailMessageUrl(token),
            images: render.images,
            imageCount: render.imageCount,
            hasQuote: render.hasQuote,
            sender: render.sender,
          },
        };
      }
      case 'measure': {
        const url = emailReaderUrlOf(asked.url);
        if (url?.kind !== 'message' || !prepared.has(url.token))
          return { ok: false, error: 'No such message' };
        const zoom = window.isDestroyed() ? 1 : window.webContents.getZoomFactor();
        const height = await measurer.measure(asked.url, asked.width, zoom);
        return height === null
          ? { ok: false, error: 'The message couldn’t be measured' }
          : { ok: true, height };
      }
      case 'save-attachment':
      case 'open-attachment': {
        const found = await ask({ op: 'part', itemId: asked.itemId, partId: asked.partId });
        if (!found.ok) return found;
        if (!('part' in found)) return { ok: false, error: 'The Core sent an unexpected answer' };
        const { part: file } = found;
        if (asked.op === 'open-attachment') {
          // Programs, scripts, installers and the like are only ever saved, never opened.
          if (!isOpenableAttachment(file.name, file.type))
            return { ok: false, error: 'This kind of file can only be saved.' };
          // Marked as from the internet first, so the app that opens it takes care (never opened unmarked
          // where the system has a mark).
          await markFromInternet(file.path);
          const problem = await shell.openPath(file.path);
          return problem ? { ok: false, error: problem } : { ok: true };
        }
        const options = { defaultPath: join(app.getPath('downloads'), file.name) };
        const chosen = await (window.isDestroyed()
          ? dialog.showSaveDialog(options)
          : dialog.showSaveDialog(window, options));
        if (chosen.canceled || !chosen.filePath) return { ok: true, saved: false };
        await copyFile(file.path, chosen.filePath);
        try {
          await markFromInternet(chosen.filePath);
        } catch {
          // Never left behind unmarked where the system has a mark.
          await rm(chosen.filePath, { force: true });
          return {
            ok: false,
            error: 'Commander couldn’t mark the file as from the internet, so didn’t save it.',
          };
        }
        return { ok: true, saved: true };
      }
      default: {
        const response = await ask(asked);
        if (!response.ok) return response;
        return 'accounts' in response ? { ok: true, accounts: response.accounts } : { ok: true };
      }
    }
  }

  ipcMain.handle(ipc.emailReader, (event, raw: unknown) => {
    // Only the window itself (its own page, never a frame in it) may ask.
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      return { ok: false, error: 'Not allowed' };
    return request(raw).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  });

  return {
    // A message from the Core. Returns true when it was an email reader reply, handled here.
    settle(raw: unknown): boolean {
      if ((raw as { type?: unknown } | null)?.type !== 'email-reader-reply') return false;
      const parsed = coreEmailReaderReply.safeParse(raw);
      if (!parsed.success) {
        const id = (raw as { id?: unknown }).id;
        const waiting = typeof id === 'number' ? pending.get(id) : undefined;
        if (waiting && typeof id === 'number') {
          pending.delete(id);
          clearTimeout(waiting.timer);
          waiting.resolve({ ok: false, error: 'The Core sent a malformed answer' });
        }
        return true;
      }
      const waiting = pending.get(parsed.data.id);
      if (!waiting) return true;
      pending.delete(parsed.data.id);
      clearTimeout(waiting.timer);
      waiting.resolve(parsed.data.response);
      return true;
    },

    // The Account is being removed: its remote images and prepared messages go too.
    forgetAccount(account: string) {
      remoteImages.forget(account);
      for (const [token, message] of [...prepared])
        if (message.render.account === account) prepared.delete(token);
    },

    // End-to-end tests: what the window's and the measurer's sessions saw (never file: or devtools:).
    seenRequests: () => [...seen],

    // End-to-end tests only: serves `html` as it is, unsanitised, as a prepared message, to show that
    // the frame's sandbox, its CSP and the request guard hold on their own. Returns its URL.
    prepareUnsanitisedForTest(html: string): string | null {
      if (!testHooks) return null;
      const token = randomBytes(16).toString('hex');
      remember(token, {
        itemId: 'test',
        render: {
          html,
          remoteImages: [],
          images: 'none',
          imageCount: 0,
          hasQuote: false,
          account: 'test',
          sender: null,
        },
      });
      return emailMessageUrl(token);
    },

    close() {
      measurer.close();
    },
  };
}
