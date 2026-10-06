import type {
  ComposeAttachment,
  ComposeBody,
  ComposeDraft,
  ComposeMode,
  ComposeState,
  DraftEntry,
  EmailAddress,
  EmailComposeSettings,
  OutboxEntry,
} from '@commander/domain';

/*
  Writing email's view of the app (#138): everything the composer, the Drafts and Outbox views and the
  writing settings ask goes through here, to the Core (over the compose bridge).
*/

export interface ComposeClient {
  /** A new composer: new mail (from `account`, or the default Account), or a reply, reply all or forward. */
  open(mode: ComposeMode, itemId?: string, account?: string): Promise<ComposeState>;
  /** A draft, in the composer. */
  openDraft(itemId: string): Promise<ComposeState>;
  /** Ares's suggested reply to a message (#143), in the composer: saved at once as an ordinary draft. */
  openSuggested(itemId: string): Promise<ComposeState>;
  /** Saves the draft (to Gmail's or Outlook's Drafts too). */
  save(draft: ComposeDraft): Promise<{ itemId: string }>;
  /** Sends it, held for the Undo time: when it goes comes back. */
  send(draft: ComposeDraft): Promise<{ itemId: string; sendAt: number }>;
  /** Takes it back before it goes: the composer opens with it again. */
  undoSend(itemId: string): Promise<ComposeState>;
  discard(itemId: string): Promise<void>;
  retry(itemId: string): Promise<void>;
  drafts(account?: string): Promise<DraftEntry[]>;
  outbox(): Promise<OutboxEntry[]>;
  /** Addresses from the User's own mail, best first. */
  suggest(text: string): Promise<EmailAddress[]>;
  /** A file to attach, kept by the Core until the message is sent. */
  attach(file: { name: string; type: string; bytes: Uint8Array }): Promise<ComposeAttachment>;
  settings(): Promise<EmailComposeSettings>;
  saveSettings(settings: EmailComposeSettings): Promise<EmailComposeSettings>;
  signature(account: string): Promise<ComposeBody>;
  saveSignature(account: string, body: ComposeBody): Promise<ComposeBody>;
}

type ComposeBridge = Pick<Window['commander'], 'compose'>;

export function composeIn(bridge: ComposeBridge): ComposeClient {
  const { compose } = bridge;
  return {
    open: (mode, itemId, account) =>
      compose({ op: 'open', mode, ...(itemId ? { itemId } : {}), ...(account ? { account } : {}) }),
    openDraft: (itemId) => compose({ op: 'open-draft', itemId }),
    openSuggested: (itemId) => compose({ op: 'open-suggested', itemId }),
    save: (draft) => compose({ op: 'save', draft }),
    send: (draft) => compose({ op: 'send', draft }),
    undoSend: (itemId) => compose({ op: 'undo-send', itemId }),
    async discard(itemId) {
      await compose({ op: 'discard', itemId });
    },
    async retry(itemId) {
      await compose({ op: 'retry', itemId });
    },
    drafts: (account) => compose({ op: 'drafts', ...(account ? { account } : {}) }),
    outbox: () => compose({ op: 'outbox' }),
    suggest: (text) => compose({ op: 'suggest', text }),
    attach: ({ name, type, bytes }) => compose({ op: 'add-attachment', name, type, bytes }),
    settings: () => compose({ op: 'settings' }),
    saveSettings: (settings) => compose({ op: 'save-settings', settings }),
    signature: (account) => compose({ op: 'signature', account }),
    saveSignature: (account, body) => compose({ op: 'save-signature', account, body }),
  };
}

const unavailable = () => Promise.reject(new Error('Writing email isn’t available here.'));

/** A stand-in where writing email isn't wired up (tests of other parts of the Email Section). */
export const noCompose: ComposeClient = {
  open: unavailable,
  openDraft: unavailable,
  openSuggested: unavailable,
  save: unavailable,
  send: unavailable,
  undoSend: unavailable,
  discard: unavailable,
  retry: unavailable,
  drafts: async () => [],
  outbox: async () => [],
  suggest: async () => [],
  attach: unavailable,
  settings: unavailable,
  saveSettings: unavailable,
  signature: unavailable,
  saveSignature: unavailable,
};

/** The draft the composer holds, as the Core takes it (what it shows beside it left out). */
export const draftOf = ({ from: _from, quote: _quote, ...draft }: ComposeState): ComposeDraft => draft;
