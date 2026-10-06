// Fixture mail for Ares's email jobs (#141): messages as Gmail sync saves them, with their bodies, and
// the User's sorting from the Email Section (`v`), so the jobs' tests read like the Email Section.
import {
  type ActionContext,
  type EmailBody,
  type EmailDetail,
  type ItemAction,
  type SourceItem,
  threadActionFields,
} from '@commander/domain';
import type { ItemStore } from '../../item-store';

export const GMAIL = 'google:alex';
export const OUTLOOK = 'microsoft:alex';
export const HOUR = 60 * 60_000;
export const DAY = 24 * HOUR;
const user: ActionContext = { by: { kind: 'user' } };

export type MailInput = Partial<EmailDetail> & {
  id: string;
  text?: string;
  html?: string | null;
  textFromHtml?: boolean;
};

/** A message as Gmail sync hands it over: its own thread unless it replies to another. */
export function mail(
  { id, text, html = null, textFromHtml = false, ...fields }: MailInput,
  at: number,
): SourceItem {
  const detail: EmailDetail = {
    kind: 'email',
    messageId: `<${id}@mail.test>`,
    inReplyTo: null,
    references: [],
    threadKey: `mid:<${id}@mail.test>`,
    sourceThreadId: `g-${id}`,
    from: { name: 'Dana Whitfield', address: 'dana@northwind.test' },
    to: [{ name: 'Alex Kim', address: 'alex@gmail.test' }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: `Subject ${id}`,
    sentAt: at - HOUR,
    snippet: `Snippet ${id}`,
    read: false,
    starred: false,
    inInbox: true,
    sentByMe: false,
    labels: [
      { id: 'INBOX', name: 'Inbox' },
      { id: 'UNREAD', name: 'Unread' },
    ],
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
    ...fields,
  };
  const body: EmailBody = { text: text ?? `Hello, this is ${id}.`, html, textFromHtml, truncated: false };
  return {
    externalId: id,
    kind: 'email',
    title: detail.subject,
    people: [detail.from?.address ?? '', ...detail.to.map((each) => each.address)],
    status: detail.inInbox ? 'open' : 'archived',
    detail,
    body,
  };
}

/** Saves mail as an Account's sync does; returns the email Items' ids by external id. */
export function deliver(
  store: ItemStore,
  at: number,
  messages: MailInput[],
  { account = GMAIL, source = 'gmail' }: { account?: string; source?: 'gmail' | 'outlook' } = {},
): Record<string, string> {
  store.saveFromSource({ source, account, items: messages.map((each) => mail(each, at)), deleted: [] });
  return Object.fromEntries(
    store
      .query({ kinds: ['email'], limit: 1000 })
      .flatMap((item) => (item.externalId ? [[item.externalId, item.id]] : [])),
  );
}

/** What `v` does in the Email Section: moves the email's whole thread, by the User. */
export function moveThread(store: ItemStore, itemId: string, bucketId: string | null) {
  const item = store.get(itemId)?.item;
  const detail = item?.detail?.kind === 'email' ? item.detail : null;
  if (!item?.account || !detail) throw new Error(`No email ${itemId}`);
  const thread = store.emailThread(item.account, detail.threadKey);
  const messages = (thread?.messages ?? []).map((each) => ({
    id: each.item.id,
    detail: each.item.detail as EmailDetail,
  }));
  const actions = threadActionFields({ type: 'bucket', bucketId }, messages).map(
    ({ itemId: id, fields }): ItemAction => ({ type: 'edit-fields', itemId: id, fields }),
  );
  return actions.length ? store.recordAll(actions, user) : [];
}

export const bucketOf = (store: ItemStore, itemId: string) => {
  const detail = store.get(itemId)?.item.detail;
  return detail?.kind === 'email' ? (detail.bucket ?? null) : null;
};

/** Lets Ares read a Gmail Account's mail, as the User's answer to the consent question would. */
export function allowCloudMail(
  store: ItemStore,
  account = GMAIL,
  answer: 'allowed' | 'declined' = 'allowed',
) {
  const settings = store.models.settings();
  store.models.saveSettings({ ...settings, cloudMail: { ...settings.cloudMail, [account]: answer } });
}
