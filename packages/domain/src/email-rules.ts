import type { EmailAddress, EmailDetail } from './email';
import type { RuleField, RuleFieldValue } from './rules';

/*
  Email's Rule fields (#137), shared by Gmail and Outlook: what an email can be filed into a Project
  ("from domain acme.com → TX") or sorted into a Bucket ("from domain stripe.com → Receipts") by. Like
  the calendar fields, each Source's ids (`gmail.from`, `outlook.from`) read every Source's mail, so a
  Rule sorts Gmail and Outlook mail alike and Outlook mail (#136) needs nothing new; the editor offers
  them once, as Email. Everything read here came from outside (ADR 0004): it is only compared.
*/

type Readable = Parameters<RuleField['read']>[0];
export type EmailSource = 'gmail' | 'outlook';

const choices = ['is', 'is-not'] as const;
const EMAIL_SOURCES: ReadonlySet<string | null> = new Set(['gmail', 'outlook']);

const emailOf = (item: Readable): EmailDetail | null =>
  EMAIL_SOURCES.has(item.source) && item.detail?.kind === 'email' ? item.detail : null;

const address = (each: EmailAddress): RuleFieldValue => {
  const value = each.address.trim().toLowerCase();
  return { value, label: value };
};

const unique = (values: RuleFieldValue[]) => [
  ...new Map(values.filter((each) => each.value).map((each) => [each.value, each])).values(),
];

// A short second-level name under a country code ("co.uk", "com.au"): not a domain anyone sends from.
const isPublicSuffix = (labels: readonly string[]) =>
  labels.length === 2 && (labels[1]?.length ?? 0) === 2 && (labels[0]?.length ?? 0) <= 3;

/** A sender's domain and its parents, most specific first: email.stripe.com, stripe.com. */
export function domainsOf(email: string): string[] {
  const at = email.lastIndexOf('@');
  const domain = (at === -1 ? '' : email.slice(at + 1)).trim().toLowerCase().replace(/\.$/, '');
  if (!domain) return [];
  const labels = domain.split('.');
  const found = [domain];
  for (let start = 1; start < labels.length - 1; start++) {
    const parent = labels.slice(start);
    if (isPublicSuffix(parent)) break;
    found.push(parent.join('.'));
  }
  return found;
}

// A List-Id as it reads: "Stripe Receipts <receipts.stripe.com>" is the list receipts.stripe.com.
const listIdOf = (header: string) => {
  const bracketed = /<([^<>]+)>/.exec(header);
  return (bracketed?.[1] ?? header).trim().toLowerCase();
};

// Gmail's flags and fixed labels, which say nothing about what an email is (see synced-fields.ts).
const NOT_LABELS = new Set([
  'INBOX',
  'UNREAD',
  'STARRED',
  'TRASH',
  'SENT',
  'DRAFT',
  'SPAM',
  'CHAT',
  'IMPORTANT',
]);

// Gmail's category labels, as the User knows them.
const CATEGORY_NAMES: Record<string, string> = {
  CATEGORY_PERSONAL: 'Primary',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_UPDATES: 'Updates',
  CATEGORY_FORUMS: 'Forums',
};

/** The Rule fields of an email Source (`gmail.from`, …), reading every Source's mail. */
export function emailRuleFields(source: EmailSource): RuleField[] {
  return [
    {
      id: `${source}.from`,
      name: 'from',
      label: 'From address',
      ops: ['is', 'is-not', 'contains'],
      read: (item) => {
        const from = emailOf(item)?.from;
        return from ? [address(from)] : [];
      },
    },
    {
      id: `${source}.domain`,
      name: 'from domain',
      label: 'From domain',
      ops: choices,
      read: (item) => {
        const from = emailOf(item)?.from;
        return from ? domainsOf(from.address).map((domain) => ({ value: domain, label: domain })) : [];
      },
    },
    {
      id: `${source}.to`,
      name: 'to or cc',
      label: 'To or cc address',
      ops: ['is', 'is-not', 'contains'],
      read: (item) => {
        const email = emailOf(item);
        return email ? unique([...email.to, ...email.cc].map(address)) : [];
      },
    },
    {
      id: `${source}.subject`,
      name: 'subject',
      label: 'Subject',
      ops: ['contains'],
      read: (item) => {
        const email = emailOf(item);
        return email ? [{ value: email.subject, label: email.subject }] : [];
      },
    },
    {
      id: `${source}.account`,
      name: 'email account',
      label: 'Account',
      ops: choices,
      read: (item) => (emailOf(item) && item.account ? [{ value: item.account, label: item.account }] : []),
    },
    {
      id: `${source}.list`,
      name: 'mailing list',
      label: 'Mailing list',
      ops: choices,
      read: (item) => {
        const list = emailOf(item)?.listId;
        const value = list ? listIdOf(list) : '';
        return value ? [{ value, label: value }] : [];
      },
    },
    {
      id: `${source}.attachment`,
      name: 'has attachment',
      label: 'Has attachment',
      ops: ['is'],
      read: (item) => {
        const email = emailOf(item);
        if (!email) return [];
        const has = email.attachments.some((attachment) => !attachment.inline) ? 'yes' : 'no';
        return [{ value: has, label: has }];
      },
    },
    {
      id: `${source}.label`,
      name: 'label or folder',
      label: 'Label or folder',
      ops: choices,
      // Gmail's own labels and categories (not the flags: Inbox, Unread, Starred, Trash), or the
      // Outlook folder the message is in.
      read: (item) =>
        emailOf(item)
          ?.labels.filter((label) => !NOT_LABELS.has(label.id))
          .map((label) => ({ value: label.id, label: CATEGORY_NAMES[label.id] ?? label.name })) ?? [],
    },
  ];
}

/** Whether a Rule field is email's (a Bucket Rule can only use these). */
export const isEmailRuleField = (field: string) => field.startsWith('gmail.') || field.startsWith('outlook.');
