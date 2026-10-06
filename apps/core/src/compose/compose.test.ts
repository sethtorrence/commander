import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMPOSE_MESSAGES,
  type ComposeDraft,
  type ComposeState,
  type EmailDetail,
  type OutgoingMessage,
  SEND_FIELD,
  type SourceItem,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import type { KnownAccount } from '../sync';
import { composeFiles, setUpCompose } from '.';
import { bodyFromHtml } from './body-from-html';

// The Core's side of writing email (#138): composers for new mail, replies and forwards (from the right
// Account, with the signature and the quote), drafts opened as the composer left them or as Gmail now
// has them, sends held for the Undo time, address suggestions from local mail, and quitting that sends
// held messages first.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const ACCOUNT = 'google:sam';
const OTHER = 'outlook:t:sam';
const T = Date.UTC(2026, 9, 7, 9);
const me = 'sam@home.test';
const dana = { name: 'Dana Whitfield', address: 'dana@northwind.test' };

let dir: string;
let store: ItemStore;
let clock: number;
let sent: unknown[];
let known: KnownAccount[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-compose-core-'));
  clock = T;
  sent = [];
  known = [
    {
      account: ACCOUNT,
      sources: ['gmail', 'google-calendar'],
      name: 'sam@home.test',
      addresses: [me],
      ownName: 'Sam Rivera',
      needsReconnect: false,
    },
    {
      account: OTHER,
      sources: ['outlook'],
      name: 'Outlook',
      addresses: ['sam@work.test'],
      ownName: 'Sam Rivera',
      needsReconnect: false,
    },
  ];
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function compose(reader?: Parameters<typeof setUpCompose>[0]['reader']) {
  return setUpCompose({
    store,
    files: composeFiles(dir),
    accounts: () => known,
    send: (message) => sent.push(message),
    now: () => clock,
    ...(reader ? { reader } : {}),
  });
}

function email(id: string, fields: Partial<EmailDetail> = {}, html: string | null = null): SourceItem {
  const detail: EmailDetail = {
    kind: 'email',
    messageId: `<${id}@northwind.test>`,
    inReplyTo: null,
    references: [],
    threadKey: `mid:<${id}@northwind.test>`,
    sourceThreadId: 'g-thread',
    from: dana,
    to: [
      { name: 'Sam Rivera', address: me },
      { name: 'Pat', address: 'pat@northwind.test' },
    ],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: 'Q4 offsite dates',
    sentAt: new Date(2026, 9, 6, 16, 0).getTime(),
    snippet: 'Can you do Thursday?',
    read: true,
    starred: false,
    inInbox: true,
    sentByMe: false,
    labels: [],
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
    ...fields,
  };
  return {
    externalId: id,
    kind: 'email',
    title: detail.subject,
    people: [],
    status: 'open',
    detail,
    body: { text: 'Can you do Thursday?', html, textFromHtml: false, truncated: false },
  };
}

const save = (...items: SourceItem[]) =>
  store.saveFromSource({ source: 'gmail', account: ACCOUNT, items, deleted: [] });
const idOf = (externalId: string) =>
  store.fromSource({ source: 'gmail', account: ACCOUNT }, [externalId])[0]?.id as string;
const draftOf = (state: ComposeState): ComposeDraft => {
  const { from: _from, quote: _quote, ...draft } = state;
  return draft;
};

describe('a composer', () => {
  it('for new mail goes from the default Account, with its signature below', async () => {
    const signature = [{ type: 'paragraph' as const, runs: [{ text: 'Sam', bold: true }] }];
    store.compose.signatures.save(OTHER, signature);
    store.compose.settings.save({ defaultAccount: OTHER, undoSeconds: 10 });

    const state = (await compose().answer({ op: 'open', mode: 'new' })) as ComposeState;

    expect(state).toMatchObject({
      itemId: null,
      mode: 'new',
      account: OTHER,
      from: { name: 'Sam Rivera', address: 'sam@work.test' },
    });
    expect(state.body).toEqual([
      { type: 'paragraph', runs: [] },
      { type: 'paragraph', runs: [] },
      { type: 'paragraph', runs: [{ text: '-- ' }] },
      ...signature,
    ]);
  });

  it('for a reply goes from the Account it arrived at, to the sender, with the quote folded as text', async () => {
    save(email('m1'));
    const state = (await compose().answer({ op: 'open', mode: 'reply', itemId: idOf('m1') })) as ComposeState;

    expect(state).toMatchObject({
      mode: 'reply',
      account: ACCOUNT,
      replyToItemId: idOf('m1'),
      to: [dana],
      cc: [],
      subject: 'Re: Q4 offsite dates',
      quote:
        'On Tue, 6 Oct 2026 at 16:00, Dana Whitfield <dana@northwind.test> wrote:\n> Can you do Thursday?',
    });
    const all = (await compose().answer({
      op: 'open',
      mode: 'reply-all',
      itemId: idOf('m1'),
    })) as ComposeState;
    expect(all.cc).toEqual([{ name: 'Pat', address: 'pat@northwind.test' }]);
  });

  it('for a forward carries the original’s attachments', async () => {
    const partFile = join(dir, 'part.pdf');
    writeFileSync(partFile, '%PDF-1.7\n');
    save(
      email('m1', {
        attachments: [{ name: 'plan.pdf', type: 'application/pdf', size: 9, partId: 'p1', inline: false }],
      }),
    );
    const reader = {
      answer: async () => ({
        ok: true as const,
        part: { path: partFile, name: 'plan.pdf', type: 'application/pdf', size: 9 },
      }),
    };

    const state = (await compose(reader).answer({
      op: 'open',
      mode: 'forward',
      itemId: idOf('m1'),
    })) as ComposeState;

    expect(state).toMatchObject({ subject: 'Fwd: Q4 offsite dates', to: [] });
    expect(state.attachments).toEqual([
      expect.objectContaining({ name: 'plan.pdf', type: 'application/pdf', size: 9 }),
    ]);
    expect(await composeFiles(dir).read(state.attachments[0]?.id as string)).toEqual(
      new TextEncoder().encode('%PDF-1.7\n'),
    );
  });
});

describe('saving and sending', () => {
  it('quotes the original’s HTML as the sanitiser cleaned it, its remote images pointing at their own addresses', async () => {
    save(
      email(
        'm1',
        {},
        '<p onclick="steal()">Can you do <b>Thursday</b>?</p><script>alert(1)</script><img src="https://cdn.test/logo.png"><img src="cid:inline-1">',
      ),
    );
    const core = compose();
    const state = (await core.answer({ op: 'open', mode: 'reply', itemId: idOf('m1') })) as ComposeState;
    const { itemId } = (await core.answer({ op: 'save', draft: draftOf(state) })) as { itemId: string };

    const html = (store.outgoing.forItem(itemId)[0]?.value as OutgoingMessage | undefined)?.html;
    expect(html).toContain('<blockquote class="gmail_quote"');
    expect(html).toContain('Can you do <b>Thursday</b>?');
    expect(html).toContain('src="https://cdn.test/logo.png"');
    expect(html).not.toMatch(/script|onclick|cid:|commander-mail/);
  });

  it('holds a send for the Undo time set, and Undo opens it again as it was', async () => {
    save(email('m1'));
    store.compose.settings.save({ defaultAccount: null, undoSeconds: 30 });
    const core = compose();
    const state = (await core.answer({ op: 'open', mode: 'reply', itemId: idOf('m1') })) as ComposeState;
    const body = [{ type: 'paragraph' as const, runs: [{ text: 'Thursday works.', italic: true }] }];
    const { itemId, sendAt } = (await core.answer({ op: 'send', draft: { ...draftOf(state), body } })) as {
      itemId: string;
      sendAt: number;
    };

    expect(sendAt).toBe(T + 30_000);
    const undone = (await core.answer({ op: 'undo-send', itemId })) as ComposeState;
    expect(undone).toMatchObject({
      itemId,
      mode: 'reply',
      to: [dana],
      subject: 'Re: Q4 offsite dates',
      body,
    });
    expect(undone.quote).toContain('> Can you do Thursday?');
    expect(store.outgoing.forItem(itemId).some((row) => row.field === SEND_FIELD)).toBe(false);
  });

  it('keeps attachments until the message no longer needs them', async () => {
    const core = compose();
    const kept = (await core.answer({
      op: 'add-attachment',
      name: 'a.txt',
      type: 'text/plain',
      bytes: new Uint8Array([1, 2]),
    })) as {
      id: string;
      size: number;
    };
    const unused = (await core.answer({
      op: 'add-attachment',
      name: 'b.txt',
      type: '',
      bytes: new Uint8Array([3]),
    })) as {
      id: string;
      type: string;
    };
    expect(kept.size).toBe(2);
    expect(unused.type).toBe('application/octet-stream');
    const state = (await core.answer({ op: 'open', mode: 'new', account: ACCOUNT })) as ComposeState;
    await core.answer({
      op: 'save',
      draft: {
        ...draftOf(state),
        to: [dana],
        attachments: [{ id: kept.id, name: 'a.txt', type: 'text/plain', size: 2 }],
      },
    });

    core.sweep();
    expect(existsSync(join(dir, 'compose-files', kept.id))).toBe(true);
    expect(existsSync(join(dir, 'compose-files', unused.id))).toBe(false);
  });

  it('sends held messages at once when Commander quits, answering once they have gone', async () => {
    save(email('m1'));
    const core = compose();
    const state = (await core.answer({ op: 'open', mode: 'reply', itemId: idOf('m1') })) as ComposeState;
    const { itemId } = (await core.answer({ op: 'send', draft: draftOf(state) })) as { itemId: string };

    expect(core.handle({ type: COMPOSE_MESSAGES.sendHeld, id: 7 })).toBe(true);
    const send = store.outgoing.forItem(itemId).find((row) => row.field === SEND_FIELD);
    expect(send?.nextAttemptAt).toBe(T);
    // The sync engine sends it.
    store.outgoing.settle([send?.id as number]);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(sent).toContainEqual({ type: COMPOSE_MESSAGES.sentHeld, id: 7 });
  });
});

describe('drafts', () => {
  it('made in Gmail open as Gmail has them, their HTML read into the composer’s model', async () => {
    save({
      ...email('draft:r-1', {
        draft: true,
        inInbox: false,
        from: { name: null, address: me },
        to: [dana],
        subject: 'Lunch?',
      }),
      body: {
        text: 'Are you free?',
        html: '<div>Are you <b>free</b> on <a href="https://cal.test/x">Tuesday</a>?</div><ul><li>Noon</li></ul><img src="https://x.test/t.gif"><script>x()</script>',
        textFromHtml: false,
        truncated: false,
      },
    });

    const state = (await compose().answer({ op: 'open-draft', itemId: idOf('draft:r-1') })) as ComposeState;

    expect(state).toMatchObject({
      itemId: idOf('draft:r-1'),
      mode: 'new',
      to: [dana],
      subject: 'Lunch?',
      quote: null,
    });
    expect(state.body).toEqual([
      {
        type: 'paragraph',
        runs: [
          { text: 'Are you ' },
          { text: 'free', bold: true },
          { text: ' on ' },
          { text: 'Tuesday', href: 'https://cal.test/x' },
          { text: '?' },
        ],
      },
      { type: 'list', ordered: false, items: [[{ text: 'Noon' }]] },
    ]);
  });

  it('written in Commander open as the composer left them, unless changed in Gmail since', async () => {
    save(email('m1'));
    const core = compose();
    const state = (await core.answer({ op: 'open', mode: 'reply', itemId: idOf('m1') })) as ComposeState;
    const body = [{ type: 'paragraph' as const, runs: [{ text: 'Thursday.' }] }];
    const { itemId } = (await core.answer({ op: 'save', draft: { ...draftOf(state), body } })) as {
      itemId: string;
    };
    expect(((await core.answer({ op: 'open-draft', itemId })) as ComposeState).body).toEqual(body);

    // Gmail answers the save, then the draft is changed in Gmail.
    const draftItem = (text: string) => ({
      ...email('draft:r-2', { ...(store.get(itemId)?.item.detail as EmailDetail), draft: true }),
      body: { text, html: `<div>${text}</div>`, textFromHtml: false, truncated: false },
    });
    store.saveFromSource({
      source: 'gmail',
      account: ACCOUNT,
      items: [{ ...draftItem('Thursday.'), commanderItemId: itemId }],
      deleted: [],
    });
    expect(((await core.answer({ op: 'open-draft', itemId })) as ComposeState).body).toEqual(body);
    save(draftItem('Friday, from my phone.'));
    expect(((await core.answer({ op: 'open-draft', itemId })) as ComposeState).body).toEqual([
      { type: 'paragraph', runs: [{ text: 'Friday, from my phone.' }] },
    ]);
  });
});

describe('address suggestions', () => {
  it('come from local mail: those the User wrote to first', async () => {
    save(
      email('m1', { from: { name: 'Fran', address: 'fran@x.test' } }),
      email('m2', { from: { name: 'Fran', address: 'fran@x.test' } }),
      email('m3', {
        from: { name: null, address: me },
        sentByMe: true,
        to: [{ name: 'Wendy', address: 'wendy@x.test' }],
      }),
    );

    const found = await compose().answer({ op: 'suggest', text: '' });
    expect((found as { address: string }[]).map((each) => each.address).slice(0, 2)).toEqual([
      'wendy@x.test',
      'fran@x.test',
    ]);
  });
});

describe('bodyFromHtml', () => {
  it('keeps only what the composer can hold, as text', () => {
    expect(
      bodyFromHtml('<table><tr><td style="color:red">Cell</td></tr></table><p>One<br>Two</p>', ''),
    ).toEqual([
      { type: 'paragraph', runs: [{ text: 'Cell' }] },
      { type: 'paragraph', runs: [{ text: 'One' }] },
      { type: 'paragraph', runs: [{ text: 'Two' }] },
    ]);
    expect(bodyFromHtml('<a href="javascript:alert(1)">x</a>', '')).toEqual([
      { type: 'paragraph', runs: [{ text: 'x' }] },
    ]);
    expect(bodyFromHtml(null, 'Line one\nLine two\n')).toEqual([
      { type: 'paragraph', runs: [{ text: 'Line one' }] },
      { type: 'paragraph', runs: [{ text: 'Line two' }] },
    ]);
  });
});
