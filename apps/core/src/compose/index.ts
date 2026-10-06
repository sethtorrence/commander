// The Core's side of writing email (#138). The window asks, over validated messages (compose-request):
// a composer for new mail, a reply, reply all or forward (its recipients, subject, signature and the
// quote to show folded); a draft to open (Commander's, or one made in Gmail or Outlook); saving and
// sending (through the Item store and its outgoing queue, compose.ts there); Undo; the Drafts and
// Outbox views; address suggestions from the User's own mail; attachments, kept in the data folder
// (`compose-files/`, readable by the User only) until the message is sent; and Settings → Email's
// default Account and Undo time, and each Account's signature.
//
// Every send is held for the Undo time in the outgoing queue, here in the Core, so closing the window to
// the tray never cancels one; Commander quitting asks for held messages to go first (compose-send-held),
// and answers once they have gone or can't (offline, refused), within the time the main process allows.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AddressSeen,
  addressBook,
  COMPOSE_MESSAGES,
  type ComposeAttachment,
  type ComposeBody,
  type ComposeDraft,
  type ComposeMode,
  type ComposeRequest,
  type ComposeState,
  coreComposeRequest,
  type EmailAddress,
  type EmailDetail,
  type Item,
  quotedText,
  replyRecipients,
  replySubject,
  type Source,
  suggestAddresses,
  withSignature,
} from '@commander/domain';
import { z } from 'zod';
import type { EmailReader } from '../email-reader';
import type { Sanitise } from '../email-reader/sanitiser';
import { sanitiseHere } from '../email-reader/sanitiser';
import type { ItemStore } from '../item-store';
import type { KnownAccount } from '../sync';
import { bodyFromHtml } from './body-from-html';
import { quoteOf } from './quote';

type Reply = {
  type: typeof COMPOSE_MESSAGES.reply;
  id: number;
  response: { ok: true; result: unknown } | { ok: false; error: string };
};

const EMAIL_SOURCES: readonly Source[] = ['gmail', 'outlook'];
const envelope = z.object({ type: z.literal(COMPOSE_MESSAGES.request), id: z.number().int().positive() });
const sendHeld = z.object({ type: z.literal(COMPOSE_MESSAGES.sendHeld), id: z.number().int().positive() });
const errorOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
// How long address suggestions are worked out from the mail Commander holds before looking again.
const ADDRESS_BOOK_MS = 30_000;
// How often quitting looks whether the held messages have gone.
const QUIT_POLL_MS = 200;
const user = { by: { kind: 'user' as const } };
const emptyBody: ComposeBody = [{ type: 'paragraph', runs: [] }];

/** The files of attachments waiting to be sent, in the data folder. */
export function composeFiles(dataDir: string) {
  const root = join(dataDir, 'compose-files');
  const pathOf = (id: string) => {
    if (!z.uuid().safeParse(id).success) throw new Error('No such attachment');
    return join(root, id);
  };
  return {
    write(bytes: Uint8Array): string {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      writeFileSync(pathOf(id), bytes, { mode: 0o600 });
      return id;
    },
    async read(id: string): Promise<Uint8Array> {
      const path = pathOf(id);
      if (!existsSync(path)) throw new Error('This message’s attachment is missing.');
      return new Uint8Array(readFileSync(path));
    },
    /** Removes every file no message still needs. */
    sweep(inUse: ReadonlySet<string>) {
      if (!existsSync(root)) return;
      for (const name of readdirSync(root)) if (!inUse.has(name)) rmSync(join(root, name), { force: true });
    },
  };
}
export type ComposeFiles = ReturnType<typeof composeFiles>;

export type ComposeOptions = {
  store: ItemStore;
  files: ComposeFiles;
  // The Accounts the main process listed: which are email Accounts, and who the User is in each.
  accounts: () => KnownAccount[];
  // Whether an Account's messages can go now (online, awake, signed in), for quitting.
  canSend?: (account: string) => boolean;
  // How the quote's HTML is cleaned: the email reader's sanitiser.
  sanitise?: Sanitise;
  // The email reader, for a forward's attachments (fetched through its Source, once).
  reader?: Pick<EmailReader, 'answer'>;
  send: (message: unknown) => void;
  onItemsChanged?: (itemIds: string[]) => void;
  now?: () => number;
};

export function setUpCompose({
  store,
  files,
  accounts,
  canSend = () => true,
  sanitise = sanitiseHere,
  reader,
  send,
  onItemsChanged = () => {},
  now = Date.now,
}: ComposeOptions) {
  let book: { at: number; entries: AddressSeen[] } | null = null;

  const emailAccounts = () =>
    accounts().filter((account) => account.sources.some((source) => EMAIL_SOURCES.includes(source)));

  function accountOf(id: string): { known: KnownAccount; source: Source; from: EmailAddress } {
    const known = emailAccounts().find((each) => each.account === id);
    if (!known) throw new Error('That isn’t an email Account Commander has.');
    const source = known.sources.find((each) => EMAIL_SOURCES.includes(each)) as Source;
    const address = known.addresses?.[0];
    if (!address)
      throw new Error('Commander doesn’t know this Account’s address yet: try again once it has synced.');
    const name = known.ownName?.trim() || null;
    return { known, source, from: { name: name && name !== address ? name : null, address } };
  }

  const myAddresses = () => emailAccounts().flatMap((account) => account.addresses ?? []);

  function emailItem(itemId: string): { item: Item; detail: EmailDetail } {
    const item = store.get(itemId)?.item;
    if (!item || item.deletedAt !== null || item.detail?.kind !== 'email' || !item.account)
      throw new Error('That email is gone.');
    return { item, detail: item.detail };
  }

  // Copies a message's attachments (a forward's, a draft made elsewhere) into the composer's files.
  async function attachmentsOf(item: Item, detail: EmailDetail): Promise<ComposeAttachment[]> {
    if (!reader) return [];
    const out: ComposeAttachment[] = [];
    for (const attachment of detail.attachments.filter((each) => !each.inline)) {
      const answer = await reader.answer({ op: 'part', itemId: item.id, partId: attachment.partId });
      if (!answer.ok || !('part' in answer)) continue;
      const bytes = readFileSync(answer.part.path);
      const id = files.write(bytes);
      out.push({
        id,
        name: attachment.name || answer.part.name,
        type: attachment.type || answer.part.type,
        size: bytes.length,
      });
    }
    return out;
  }

  async function open(mode: ComposeMode, itemId?: string, accountId?: string): Promise<ComposeState> {
    if (mode === 'new' || !itemId) {
      const chosen =
        accountId ?? store.compose.settings.read().defaultAccount ?? emailAccounts()[0]?.account ?? null;
      if (!chosen)
        throw new Error('Connect a Google or Outlook Account in Settings → Accounts to write email.');
      const fallback = emailAccounts()[0]?.account;
      const account = emailAccounts().some((each) => each.account === chosen) ? chosen : fallback;
      if (!account)
        throw new Error('Connect a Google or Outlook Account in Settings → Accounts to write email.');
      const { from } = accountOf(account);
      return {
        itemId: null,
        mode: 'new',
        account,
        replyToItemId: null,
        to: [],
        cc: [],
        bcc: [],
        subject: '',
        body: withSignature(emptyBody, store.compose.signatures.read(account)),
        attachments: [],
        from,
        quote: null,
      };
    }
    const { item, detail } = emailItem(itemId);
    const account = item.account as string;
    const { from } = accountOf(account);
    const { to, cc } = replyRecipients(detail, mode, myAddresses());
    // The folded preview is text only: the quote's HTML is made when the message is first saved.
    const quote = quotedText(detail, store.emailBody(item.id)?.text ?? '', mode);
    return {
      itemId: null,
      mode,
      account,
      replyToItemId: item.id,
      to,
      cc,
      bcc: [],
      subject: replySubject(detail.subject, mode),
      body: withSignature(emptyBody, store.compose.signatures.read(account)),
      attachments: mode === 'forward' ? await attachmentsOf(item, detail) : [],
      from,
      quote,
    };
  }

  // A message as the composer opens it: from Commander's record, unless it was changed in Gmail or
  // Outlook since Commander last saved it (or was made there), when it opens as the Source has it.
  async function stateOf(itemId: string): Promise<ComposeState> {
    const { item, detail } = emailItem(itemId);
    const account = item.account as string;
    const { from } = accountOf(account);
    const rec = store.compose.record(itemId);
    const body = store.emailBody(itemId);
    const answered = store.compose.answeredText(itemId);
    const changedElsewhere = !rec || (answered !== null && body !== null && answered !== body.text);
    const base = {
      itemId,
      account,
      to: detail.to,
      cc: detail.cc,
      bcc: detail.bcc,
      subject: detail.subject,
      from,
    };
    if (!changedElsewhere && rec) {
      return {
        ...base,
        mode: rec.mode,
        replyToItemId: rec.replyToItemId,
        body: rec.body,
        attachments: rec.attachments,
        quote: rec.quote?.text ?? null,
      };
    }
    return {
      ...base,
      mode: rec?.mode ?? (detail.inReplyTo ? 'reply' : 'new'),
      replyToItemId: rec?.replyToItemId ?? null,
      body: bodyFromHtml(body?.html ?? null, body?.text ?? ''),
      attachments: await attachmentsOf(item, detail),
      // A draft made elsewhere carries its quote in its body.
      quote: null,
    };
  }

  // The quote a message needs when it has none yet (a reply's or forward's first save).
  async function quoteFor(draft: ComposeDraft) {
    if (draft.mode === 'new' || !draft.replyToItemId) return null;
    if (draft.itemId && store.compose.record(draft.itemId)?.quote) return null;
    // A draft made elsewhere carries its quote in its body.
    if (draft.itemId && !store.compose.record(draft.itemId)) return null;
    const original = store.get(draft.replyToItemId)?.item;
    if (original?.detail?.kind !== 'email') return null;
    return quoteOf(original.detail, store.emailBody(original.id), draft.mode, sanitise);
  }

  async function contextFor(draft: ComposeDraft) {
    const { source, from } = accountOf(draft.account);
    return { ...user, source, from, quote: await quoteFor(draft) };
  }

  function suggest(text: string, limit = 8) {
    if (!book || now() - book.at > ADDRESS_BOOK_MS)
      book = { at: now(), entries: addressBook(store.compose.addressHistory(), myAddresses()) };
    return suggestAddresses(book.entries, text, limit);
  }

  async function answer(request: ComposeRequest): Promise<unknown> {
    switch (request.op) {
      case 'open':
        return open(request.mode, request.itemId, request.account);
      case 'open-draft': {
        const { detail } = emailItem(request.itemId);
        if (!detail.draft) throw new Error('That message has already been sent.');
        return stateOf(request.itemId);
      }
      case 'save': {
        const saved = store.compose.save(request.draft, await contextFor(request.draft));
        onItemsChanged([saved.itemId]);
        return saved;
      }
      case 'send': {
        const { undoSeconds } = store.compose.settings.read();
        const sent = store.compose.send(
          request.draft,
          await contextFor(request.draft),
          now() + undoSeconds * 1000,
        );
        onItemsChanged([sent.itemId]);
        return sent;
      }
      case 'undo-send': {
        store.compose.undoSend(request.itemId, user);
        onItemsChanged([request.itemId]);
        return stateOf(request.itemId);
      }
      case 'discard':
        store.compose.discard(request.itemId, user);
        onItemsChanged([request.itemId]);
        return {};
      case 'retry':
        store.compose.retry(request.itemId);
        onItemsChanged([request.itemId]);
        return {};
      case 'drafts':
        return store.compose.drafts(request.account);
      case 'outbox':
        return store.compose.outbox();
      case 'suggest':
        return suggest(request.text, request.limit);
      case 'add-attachment': {
        const id = files.write(request.bytes);
        return {
          id,
          name: request.name,
          type: request.type || 'application/octet-stream',
          size: request.bytes.byteLength,
        };
      }
      case 'settings':
        return store.compose.settings.read();
      case 'save-settings':
        return store.compose.settings.save(request.settings);
      case 'signature':
        return store.compose.signatures.read(request.account) ?? [];
      case 'save-signature':
        return store.compose.signatures.save(request.account, request.body);
    }
  }

  // Commander is quitting: held messages go now; answers once none is left to go that can.
  async function sendHeldNow(): Promise<void> {
    store.compose.releaseHeld();
    for (;;) {
      const waiting = store.compose
        .outbox()
        .filter((entry) => entry.state !== 'failed' && (entry.state === 'sending' || canSend(entry.account)));
      if (!waiting.length) return;
      await new Promise((resolve) => setTimeout(resolve, QUIT_POLL_MS));
    }
  }

  return {
    answer,

    // A message from the main process. Returns true when it was one of compose's, handled here.
    handle(raw: unknown): boolean {
      const held = sendHeld.safeParse(raw);
      if (held.success) {
        void sendHeldNow().finally(() => send({ type: COMPOSE_MESSAGES.sentHeld, id: held.data.id }));
        return true;
      }
      const header = envelope.safeParse(raw);
      if (!header.success) return false;
      const reply = (response: Reply['response']) =>
        send({ type: COMPOSE_MESSAGES.reply, id: header.data.id, response } satisfies Reply);
      const parsed = coreComposeRequest.safeParse(raw);
      if (!parsed.success) {
        reply({ ok: false, error: `Malformed request: ${parsed.error.message}` });
        return true;
      }
      answer(parsed.data.request).then(
        (result) => reply({ ok: true, result }),
        (error) => reply({ ok: false, error: errorOf(error) }),
      );
      return true;
    },

    // Attachments no message still needs are removed (at start-up, and now and then).
    sweep() {
      files.sweep(store.compose.attachmentsInUse());
    },
  };
}

export type Compose = ReturnType<typeof setUpCompose>;
