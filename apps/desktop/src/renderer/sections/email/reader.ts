import type {
  EmailImageAccount,
  EmailReaderRequest,
  EmailReaderResponse,
  EmailView,
} from '@commander/domain';

/*
  The email reader as the window sees it (#134): everything goes through the main process, which asks
  the Core to sanitise a message and serves it to a sandboxed frame from its own protocol. The window
  never holds a message's HTML; it only points a frame at the URL it is given.
*/
export interface EmailReaderClient {
  /** Prepares a message's HTML for its frame; null when it has none to show (read its text instead). */
  open(itemId: string, quotes: boolean): Promise<EmailView | null>;
  /** The prepared document's height at this width, or null. */
  measure(url: string, width: number): Promise<number | null>;
  /** Save… (the system's save dialog). Resolves with whether it was saved; rejects with why not. */
  saveAttachment(itemId: string, partId: string): Promise<boolean>;
  /** Opens with the system's default app (never programs: those can only be saved). */
  openAttachment(itemId: string, partId: string): Promise<void>;
  showImages(itemId: string): Promise<void>;
  trustSender(itemId: string): Promise<void>;
  untrustSender(account: string, address: string): Promise<void>;
  setAskFirst(account: string, on: boolean): Promise<void>;
  imageSettings(): Promise<EmailImageAccount[]>;
  /** The real destination of the link hovered in a frame ('' when none). Returns the unsubscribe. */
  onLinkHover(listener: (url: string) => void): () => void;
}

type Bridge = Pick<Window['commander'], 'emailReader' | 'onEmailLinkHover'>;

export function emailReaderIn(bridge: Bridge): EmailReaderClient {
  const call = async (request: EmailReaderRequest): Promise<EmailReaderResponse & { ok: true }> => {
    const response = await bridge.emailReader(request);
    if (!response.ok) throw new Error(response.error);
    return response;
  };
  return {
    async open(itemId, quotes) {
      const response = await bridge.emailReader({ op: 'open', itemId, quotes });
      return response.ok && 'view' in response ? response.view : null;
    },
    async measure(url, width) {
      const response = await bridge.emailReader({ op: 'measure', url, width });
      return response.ok && 'height' in response ? response.height : null;
    },
    async saveAttachment(itemId, partId) {
      const response = await call({ op: 'save-attachment', itemId, partId });
      return 'saved' in response && response.saved;
    },
    async openAttachment(itemId, partId) {
      await call({ op: 'open-attachment', itemId, partId });
    },
    async showImages(itemId) {
      await call({ op: 'show-images', itemId });
    },
    async trustSender(itemId) {
      await call({ op: 'trust-sender', itemId });
    },
    async untrustSender(account, address) {
      await call({ op: 'untrust-sender', account, address });
    },
    async setAskFirst(account, on) {
      await call({ op: 'set-ask-first', account, on });
    },
    async imageSettings() {
      const response = await call({ op: 'image-settings' });
      return 'accounts' in response ? response.accounts : [];
    },
    onLinkHover: (listener) => bridge.onEmailLinkHover(listener),
  };
}

/** A reader that shows every message as text (tests, and anywhere without the bridge). */
export const textOnlyReader: EmailReaderClient = {
  open: async () => null,
  measure: async () => null,
  saveAttachment: async () => false,
  openAttachment: async () => {},
  showImages: async () => {},
  trustSender: async () => {},
  untrustSender: async () => {},
  setAskFirst: async () => {},
  imageSettings: async () => [],
  onLinkHover: () => () => {},
};
