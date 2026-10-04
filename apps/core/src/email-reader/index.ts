// The Core's side of the email reader (#134). The main process asks, over validated messages:
//
// - render: one message's HTML, sanitised for the reader's frame (sanitize.ts) under its Account's
//   image rules, with its URLs named for the token the main process chose;
// - part: one of the message's parts (an inline image by Content-ID, or an attachment by part id),
//   fetched through its Source's adapter the first time and cached in the Account's folder under the
//   data folder (`email-parts/<Account>/<part>/<name>`, readable by the User only), so it is fetched
//   once; the folder goes when the Account is removed (`forget`);
// - the image rules (Show images, Always show from this sender, Ask before showing images), kept by
//   the Item store, and listed for Settings → Email.
//
// Image rules, as each Account's provider does it (decision #15): a Gmail Account shows remote images
// unless it asks first; an Outlook Account holds them back unless the User showed this message's or
// trusts its sender. Nothing here is ever handed to Ares: attachments never reach a model (#22).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CoreEmailReaderReply,
  type CoreEmailRequest,
  coreEmailReaderRequest,
  type EmailDetail,
  type EmailImageAccount,
  normaliseContentId,
  type Source,
  safeAttachmentName,
  sourceItem,
} from '@commander/domain';
import { PartNotFound, type SourceAdapter } from '@commander/sources';
import { z } from 'zod';
import type { AccessTokens } from '../access-tokens';
import type { ItemStore } from '../item-store';
import type { KnownAccount } from '../sync';
import { type Sanitise, sanitiseHere } from './sanitiser';
import type { SanitizedEmail } from './sanitize';
import { TooComplex } from './sanitize';

type Response = CoreEmailReaderReply['response'];

export type EmailReaderOptions = {
  store: ItemStore;
  dataDir: string;
  accessTokens: Pick<AccessTokens, 'request'>;
  // The Source's adapter, for its parts.
  adapterFor: (source: Source) => SourceAdapter | undefined;
  // The Accounts the main process listed, for Settings → Email.
  accounts: () => KnownAccount[];
  send: (message: CoreEmailReaderReply) => void;
  // The largest part fetched (about the largest message Gmail and Exchange take).
  maxPartBytes?: number;
  // How messages are sanitised: in a worker thread with a time limit in the Core (sanitiser.ts).
  sanitise?: Sanitise;
  // End-to-end tests (--test-hooks) may save email Items as a Source's sync will (email-test-items).
  testHooks?: boolean;
  onItemsChanged?: (itemIds: string[]) => void;
};

// Test hooks only: email Items to save as an email Source's sync would.
const testItems = z.object({
  type: z.literal('email-test-items'),
  source: z.enum(['gmail', 'outlook']),
  account: z.string().min(1),
  items: z.array(sourceItem).max(100),
});

const EMAIL_SOURCES = new Set<Source>(['gmail', 'outlook']);
const envelope = z.object({ type: z.literal('email-reader-request'), id: z.number().int().positive() });
const hash = (...parts: string[]) =>
  createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
const errorOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function setUpEmailReader({
  store,
  dataDir,
  accessTokens,
  adapterFor,
  accounts,
  send,
  maxPartBytes = 35 * 1024 * 1024,
  sanitise = sanitiseHere,
  testHooks = false,
  onItemsChanged,
}: EmailReaderOptions) {
  const root = join(dataDir, 'email-parts');
  const accountDir = (account: string) => join(root, hash(account));
  // Parts being fetched, so a frame and the measurer asking at once fetch once.
  const fetching = new Map<string, Promise<Response>>();
  // Content-IDs found by asking the Source (messages synced before Content-IDs were kept), and those
  // it didn't have, so each costs the Source's quota once.
  const contentIds = new Map<string, string>();
  const missing = new Set<string>();
  // Bumped when an Account is removed, so a part fetched meanwhile isn't written back.
  const generations = new Map<string, number>();

  // A live email Item from an email Source, with its detail.
  function emailOf(itemId: string) {
    const item = store.get(itemId)?.item;
    if (item?.kind !== 'email' || item.deletedAt !== null || !item.account) return null;
    if (!item.source || !EMAIL_SOURCES.has(item.source) || item.detail?.kind !== 'email') return null;
    return { item, account: item.account, source: item.source, detail: item.detail as EmailDetail };
  }

  const senderOf = (detail: EmailDetail) => detail.from?.address.trim().toLowerCase() || null;

  function imagesFor(email: NonNullable<ReturnType<typeof emailOf>>): 'shown' | 'held' {
    const rules = store.emailImages;
    if (rules.messageShown(email.account, email.item.id)) return 'shown';
    const sender = senderOf(email.detail);
    if (sender && rules.senderTrusted(email.account, sender)) return 'shown';
    if (email.source === 'gmail') return rules.askFirst(email.account) ? 'held' : 'shown';
    return 'held';
  }

  async function render(itemId: string, quotes: boolean, token: string): Promise<Response> {
    const email = emailOf(itemId);
    if (!email) return { ok: false, error: 'There is no such email.' };
    const html = store.emailBody(itemId)?.html;
    if (!html) return { ok: false, error: 'This message has no HTML.' };
    const images = imagesFor(email);
    let sanitized: SanitizedEmail;
    try {
      sanitized = await sanitise({ html, images, quotes, token });
    } catch (error) {
      if (error instanceof TooComplex) return { ok: false, error: error.message };
      throw error;
    }
    const imageCount = images === 'shown' ? sanitized.remoteImages.length : sanitized.heldImages;
    return {
      ok: true,
      render: {
        html: sanitized.html,
        remoteImages: sanitized.remoteImages,
        images: imageCount === 0 ? 'none' : images,
        imageCount,
        hasQuote: sanitized.hasQuote,
        account: email.account,
        sender: senderOf(email.detail),
      },
    };
  }

  // The cached file of a part, if it is there.
  function cached(account: string, itemId: string, partId: string) {
    const folder = join(accountDir(account), hash(itemId, partId));
    if (!existsSync(folder)) return null;
    const [name] = readdirSync(folder);
    if (!name) return null;
    const path = join(folder, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile()) return null;
    // The type the Source gave, kept beside the folder.
    const typeFile = `${folder}.type`;
    const type = existsSync(typeFile) ? readFileSync(typeFile, 'utf8').trim() : null;
    return { path, name, size: stat.size, type };
  }

  async function part(itemId: string, wanted: { partId: string } | { contentId: string }): Promise<Response> {
    const email = emailOf(itemId);
    if (!email) return { ok: false, error: 'There is no such email.' };
    const { account, detail } = email;
    // The part id: asked for, or found from the Content-ID (in the detail, or learnt from the Source).
    let partId: string | undefined;
    if ('partId' in wanted) partId = wanted.partId;
    else {
      const contentId = normaliseContentId(wanted.contentId);
      const missKey = `${itemId}\u0000${contentId}`;
      partId =
        detail.attachments.find((each) => each.contentId === contentId)?.partId ?? contentIds.get(missKey);
      // A message synced with its Content-IDs names every inline part it has: no asking the Source for
      // others. Nor again for one the Source already said it hasn't.
      const listsContentIds = detail.attachments.some((each) => each.contentId !== undefined);
      if (partId === undefined && (listsContentIds || missing.has(missKey)))
        return { ok: false, error: 'This message has no such part.' };
    }
    const known =
      partId !== undefined ? detail.attachments.find((each) => each.partId === partId) : undefined;
    if (partId !== undefined) {
      const hit = cached(account, itemId, partId);
      if (hit)
        return {
          ok: true,
          part: {
            path: hit.path,
            name: hit.name,
            size: hit.size,
            type: hit.type ?? known?.type ?? 'application/octet-stream',
          },
        };
    }
    const adapter = adapterFor(email.source);
    if (!adapter?.fetchPart) return { ok: false, error: 'Commander can’t fetch parts from this Source.' };
    const fetchPart = adapter.fetchPart.bind(adapter);
    const key = `${itemId}\u0000${partId ?? `cid:${'contentId' in wanted ? normaliseContentId(wanted.contentId) : ''}`}`;
    const running = fetching.get(key);
    if (running) return running;
    const generation = generations.get(account) ?? 0;
    const job = (async (): Promise<Response> => {
      try {
        const fetched = await fetchPart({
          account,
          externalId: email.item.externalId ?? '',
          part: partId !== undefined ? { partId } : wanted,
          maxBytes: maxPartBytes,
          accessToken: () => accessTokens.request(account),
          signal: new AbortController().signal,
        });
        // The Account was removed (or the message deleted) while it was fetched: nothing is written.
        if ((generations.get(account) ?? 0) !== generation || !emailOf(itemId))
          return { ok: false, error: 'There is no such email.' };
        if ('contentId' in wanted)
          contentIds.set(`${itemId}\u0000${normaliseContentId(wanted.contentId)}`, fetched.partId);
        const name = safeAttachmentName(fetched.name);
        const folder = join(accountDir(account), hash(itemId, fetched.partId));
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const path = join(folder, name);
        writeFileSync(path, fetched.bytes, { mode: 0o600 });
        writeFileSync(`${folder}.type`, fetched.type, { mode: 0o600 });
        return { ok: true, part: { path, name, type: fetched.type, size: fetched.bytes.length } };
      } catch (error) {
        if (error instanceof PartNotFound && 'contentId' in wanted)
          missing.add(`${itemId}\u0000${normaliseContentId(wanted.contentId)}`);
        return { ok: false, error: errorOf(error) };
      } finally {
        fetching.delete(key);
      }
    })();
    fetching.set(key, job);
    return job;
  }

  function imageSettings(): EmailImageAccount[] {
    return accounts().flatMap((known) => {
      const source = known.sources.find((each) => EMAIL_SOURCES.has(each)) as 'gmail' | 'outlook' | undefined;
      if (!source) return [];
      return [
        {
          account: known.account,
          name: known.name,
          source,
          askFirst: store.emailImages.askFirst(known.account),
          trustedSenders: store.emailImages.trustedSenders(known.account),
        },
      ];
    });
  }

  async function answer(request: CoreEmailRequest): Promise<Response> {
    switch (request.op) {
      case 'render':
        return render(request.itemId, request.quotes, request.token);
      case 'part':
        return part(
          request.itemId,
          'partId' in request ? { partId: request.partId } : { contentId: request.contentId },
        );
      case 'image-settings':
        return { ok: true, accounts: imageSettings() };
      case 'set-ask-first':
        store.emailImages.setAskFirst(request.account, request.on);
        return { ok: true };
      case 'untrust-sender':
        store.emailImages.untrustSender(request.account, request.address);
        return { ok: true };
      case 'show-images':
      case 'trust-sender': {
        const email = emailOf(request.itemId);
        if (!email) return { ok: false, error: 'There is no such email.' };
        if (request.op === 'show-images') store.emailImages.showMessage(email.account, email.item.id);
        else {
          const sender = senderOf(email.detail);
          if (!sender) return { ok: false, error: 'This message has no sender to trust.' };
          store.emailImages.trustSender(email.account, sender);
        }
        return { ok: true };
      }
    }
  }

  return {
    answer,

    // A message from the main process. Returns true when it was an email reader request.
    handle(raw: unknown): boolean {
      if (testHooks) {
        const seeded = testItems.safeParse(raw);
        if (seeded.success) {
          const { source, account, items } = seeded.data;
          const saved = store.saveFromSource({ source, account, items, deleted: [] });
          if (saved.created.length) onItemsChanged?.(saved.created);
          return true;
        }
      }
      const header = envelope.safeParse(raw);
      if (!header.success) return false;
      const reply = (response: Response) =>
        send({ type: 'email-reader-reply', id: header.data.id, response });
      const parsed = coreEmailReaderRequest.safeParse(raw);
      if (!parsed.success) {
        reply({ ok: false, error: `Malformed request: ${parsed.error.message}` });
        return true;
      }
      answer(parsed.data.request).then(reply, (error) => reply({ ok: false, error: errorOf(error) }));
      return true;
    },

    // The Account is being removed: its cached parts and image rules go with it.
    forget(account: string) {
      generations.set(account, (generations.get(account) ?? 0) + 1);
      rmSync(accountDir(account), { recursive: true, force: true });
      store.emailImages.removeAccount(account);
      for (const key of contentIds.keys()) {
        const itemId = key.split('\u0000')[0] ?? '';
        if (store.get(itemId)?.item.account === account) contentIds.delete(key);
      }
    },
  };
}

export type EmailReader = ReturnType<typeof setUpEmailReader>;
