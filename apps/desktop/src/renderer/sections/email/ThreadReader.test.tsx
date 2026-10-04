// @vitest-environment jsdom
import type { EmailBody, EmailDetail, EmailThread, EmailView, Item } from '@commander/domain';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRAME_SANDBOX } from './EmailFrame';
import type { EmailReaderClient } from './reader';
import { ThreadReader } from './ThreadReader';

// The thread view's HTML messages (#134): a sandboxed frame pointed at the URL the main process gives,
// never the HTML itself; the image bar; quoted history; links' real destinations; attachments.

const detail = (overrides: Partial<EmailDetail> = {}): EmailDetail => ({
  kind: 'email',
  messageId: '<m@x>',
  inReplyTo: null,
  references: [],
  threadKey: 'k',
  sourceThreadId: null,
  from: { name: 'Shop', address: 'news@shop.test' },
  to: [],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: 'Autumn sale',
  sentAt: Date.UTC(2026, 9, 3, 9),
  snippet: 'Sale',
  read: true,
  starred: false,
  inInbox: true,
  sentByMe: false,
  labels: [],
  attachments: [
    { name: 'invoice.pdf', type: 'application/pdf', size: 183_002, partId: '2', inline: false },
    { name: 'setup.exe', type: 'application/x-msdownload', size: 900, partId: '3', inline: false },
    { name: 'logo.png', type: 'image/png', size: 10, partId: '4', inline: true, contentId: 'logo' },
  ],
  hasInvitation: false,
  listUnsubscribe: null,
  listId: null,
  ...overrides,
});

const item = (id: string, overrides: Partial<EmailDetail> = {}): Item => ({
  id,
  kind: 'email',
  source: 'outlook',
  account: 'outlook:1',
  externalId: id,
  title: 'Autumn sale',
  people: [],
  filing: null,
  status: 'open',
  detail: detail(overrides),
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
});

const HTML: EmailBody = { text: 'Sale', html: '<p>Sale</p>', textFromHtml: false, truncated: false };
const thread = (body: EmailBody = HTML): EmailThread => ({
  account: 'outlook:1',
  threadKey: 'k',
  messages: [{ item: item('m1'), body }],
});

function fakeReader(view: Partial<EmailView> = {}) {
  let hover: (url: string) => void = () => {};
  const reader = {
    open: vi.fn(async (_itemId: string, quotes: boolean) => ({
      url: `commander-mail://message/${quotes ? 'b' : 'a'}${'0'.repeat(31)}`,
      images: 'held' as const,
      imageCount: 3,
      hasQuote: true,
      sender: 'news@shop.test',
      ...view,
    })),
    measure: vi.fn(async () => 640),
    saveAttachment: vi.fn(async () => true),
    openAttachment: vi.fn(async () => {}),
    showImages: vi.fn(async () => {}),
    trustSender: vi.fn(async () => {}),
    untrustSender: vi.fn(async () => {}),
    setAskFirst: vi.fn(async () => {}),
    imageSettings: vi.fn(async () => []),
    onLinkHover: (listener: (url: string) => void) => {
      hover = listener;
      return () => {};
    },
  } satisfies EmailReaderClient;
  return { reader, hover: (url: string) => act(() => hover(url)) };
}

const show = (reader: EmailReaderClient, given = thread()) =>
  render(
    <ThreadReader
      thread={given}
      summary={null}
      accountName={(id) => id}
      reader={reader}
      onClose={() => {}}
    />,
  );

afterEach(cleanup);

describe('an HTML message in the thread view', () => {
  it('shows in a frame sandboxed with nothing but popups, pointed at the main process’s URL', async () => {
    const { reader } = fakeReader();
    show(reader);
    const frame = (await screen.findByTestId('email-frame')) as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('allow-popups allow-popups-to-escape-sandbox');
    expect(FRAME_SANDBOX).not.toMatch(/allow-scripts|allow-same-origin|allow-forms|allow-top-navigation/);
    expect(frame.getAttribute('src')).toBe(`commander-mail://message/a${'0'.repeat(31)}`);
    expect(frame.hasAttribute('srcdoc')).toBe(false);
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(reader.open).toHaveBeenCalledWith('m1', false);
    // Never the HTML itself in the window.
    expect(document.body.innerHTML).not.toContain('<p>Sale</p>');
  });

  it('holds images back with Show images and Always show from this sender, opening it again after either', async () => {
    const { reader } = fakeReader();
    show(reader);
    const bar = await screen.findByTestId('email-images-bar');
    expect(bar.textContent).toContain('3 images held back');
    fireEvent.click(within(bar).getByRole('button', { name: 'Show images' }));
    await waitFor(() => expect(reader.showImages).toHaveBeenCalledWith('m1'));
    await waitFor(() => expect(reader.open).toHaveBeenCalledTimes(2));
    fireEvent.click(
      within(screen.getByTestId('email-images-bar')).getByRole('button', {
        name: 'Always show from this sender',
      }),
    );
    await waitFor(() => expect(reader.trustSender).toHaveBeenCalledWith('m1'));
    await waitFor(() => expect(reader.open).toHaveBeenCalledTimes(3));
  });

  it('shows no bar when images are shown or there are none', async () => {
    const { reader } = fakeReader({ images: 'shown' });
    show(reader);
    await screen.findByTestId('email-frame');
    expect(screen.queryByTestId('email-images-bar')).toBeNull();
  });

  it('unfolds quoted history behind “…”', async () => {
    const { reader } = fakeReader();
    show(reader);
    fireEvent.click(await screen.findByRole('button', { name: 'Show quoted text' }));
    await waitFor(() => expect(reader.open).toHaveBeenLastCalledWith('m1', true));
    await waitFor(() =>
      expect(screen.getByTestId('email-frame').getAttribute('src')).toBe(
        `commander-mail://message/b${'0'.repeat(31)}`,
      ),
    );
  });

  it('sizes the frame to the measured height', async () => {
    const { reader } = fakeReader();
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 700 });
    show(reader);
    await waitFor(() =>
      expect((screen.getByTestId('email-frame') as HTMLIFrameElement).style.height).toBe('640px'),
    );
    expect(reader.measure).toHaveBeenCalledWith(`commander-mail://message/a${'0'.repeat(31)}`, 700);
    Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  });

  it('shows a hovered link’s real destination at the foot of the thread, until the pointer leaves it', async () => {
    const { reader, hover } = fakeReader();
    show(reader);
    await screen.findByTestId('email-frame');
    expect(screen.getByTestId('email-link-target').textContent).toBe('');
    hover('https://evil.example/login');
    expect(screen.getByTestId('email-link-target').textContent).toBe('→ https://evil.example/login');
    hover('');
    expect(screen.getByTestId('email-link-target').textContent).toBe('');
  });

  it('shows the text instead when the message can’t be shown as HTML', async () => {
    const { reader } = fakeReader();
    reader.open.mockResolvedValueOnce(null as never);
    show(reader);
    await waitFor(() => expect(screen.getByTestId('email-body').textContent).toBe('Sale'));
    expect(screen.queryByTestId('email-frame')).toBeNull();
  });
});

describe('attachments', () => {
  it('lists name, type and size, with Save… for each and Open only for what isn’t a program', async () => {
    const { reader } = fakeReader();
    show(reader);
    const rows = await screen.findAllByTestId('email-attachment');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('invoice.pdf');
    expect(rows[0]?.textContent).toContain('application/pdf · 179 KB');
    fireEvent.click(screen.getByRole('button', { name: 'Save invoice.pdf' }));
    await waitFor(() => expect(reader.saveAttachment).toHaveBeenCalledWith('m1', '2'));
    fireEvent.click(screen.getByRole('button', { name: 'Open invoice.pdf' }));
    await waitFor(() => expect(reader.openAttachment).toHaveBeenCalledWith('m1', '2'));
    expect(screen.getByRole('button', { name: 'Save setup.exe' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open setup.exe' })).toBeNull();
  });
});

describe('a plain-text message', () => {
  it('shows its text with web and mail links, and folds its quoted history', async () => {
    const { reader } = fakeReader();
    show(
      reader,
      thread({
        text: 'Track it at https://shop.test/t/1\n\nOn Fri, Dana wrote:\n> Where is it?',
        html: null,
        textFromHtml: false,
        truncated: false,
      }),
    );
    const body = await screen.findByTestId('email-body');
    expect(body.textContent).toBe('Track it at https://shop.test/t/1');
    const link = within(body).getByRole('link');
    expect(link.getAttribute('href')).toBe('https://shop.test/t/1');
    expect(link.getAttribute('target')).toBe('_blank');
    fireEvent.click(screen.getByRole('button', { name: 'Show quoted text' }));
    expect(screen.getByTestId('email-body').textContent).toContain('> Where is it?');
    expect(reader.open).not.toHaveBeenCalled();
  });
});
