import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { HOSTILE } from '../../core/src/email-reader/hostile-corpus';
import { sanitizeEmailHtml } from '../../core/src/email-reader/sanitize';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import { type FakeMicrosoft, SAM, startFakeMicrosoft } from '../src/main/microsoft/fake-microsoft-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// The sandboxed HTML reader end to end (#134), against a fake Google (and Microsoft) on this machine
// and a stand-in for senders' servers ("the tracker"), which counts every request it gets. Hostile
// email (every vector in the sanitiser's corpus, aimed at the tracker and at the window) opens with
// no script running, the window untouched, and no request leaving while images are held back; images
// then load only through the main process; links go only to the system browser; inline images and
// attachments come from the message's own parts. Tokens are stored in the real keyring, so these need
// the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n% a tiny agenda\n');

let google: FakeGoogle;
let microsoft: FakeMicrosoft | undefined;
let tracker: Server;
let trackerBase: string;
let hits: string[];
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  hits = [];
  tracker = createServer((request, response) => {
    hits.push(request.url ?? '');
    if (/\.(png|gif)(\?|$)/.test(request.url ?? ''))
      return response.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    response.writeHead(200, { 'content-type': 'text/html' }).end('<script>alert(1)</script>');
  });
  await new Promise<void>((resolve) => tracker.listen(0, '127.0.0.1', resolve));
  trackerBase = `http://127.0.0.1:${(tracker.address() as AddressInfo).port}`;
  google = await startFakeGoogle();
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await google?.close();
  await microsoft?.close();
  microsoft = undefined;
  tracker.closeAllConnections();
  await new Promise((resolve) => tracker.close(resolve));
});

function environment() {
  const env: Record<string, string> = {
    COMMANDER_TEST_HOOKS: '1',
    // The tracker is on this machine, which remote images are otherwise never fetched from.
    COMMANDER_TEST_REMOTE_IMAGES_LOOPBACK: '1',
    COMMANDER_TEST_GOOGLE: JSON.stringify({
      clientId: google.clientId,
      clientSecret: google.clientSecret,
      authorizeUrl: google.authorizeUrl,
      tokenUrl: google.tokenUrl,
      userinfoUrl: google.userinfoUrl,
      gmailUrl: google.gmailUrl,
    }),
  };
  if (microsoft)
    env.COMMANDER_TEST_MICROSOFT = JSON.stringify({
      clientId: microsoft.clientId,
      tenantId: microsoft.tenantId,
      loginUrl: microsoft.loginUrl,
      graphUrl: microsoft.graphUrl,
    });
  return env;
}

// The system browser: sign-in pages are followed back to Commander; anything else is only noted.
async function standInForTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { openedInBrowser: opened });
    shell.openExternal = async (url: string) => {
      if (url.startsWith('http://127.0.0.1') || url.includes('/authorize') || url.includes('oauth2'))
        await fetch(url);
      else opened.push(url);
    };
  });
}
const openedInBrowser = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { openedInBrowser: string[] }).openedInBrowser);

async function connect(window: Page, source: 'google' | 'outlook') {
  if (!(await window.getByTestId('settings').isVisible())) await openSettings(window);
  const section = window.getByTestId('accounts-panel').getByTestId(`source-${source}`);
  await section
    .getByRole('button', { name: source === 'google' ? 'Connect Google' : 'Connect Outlook' })
    .click();
  await expect(section.getByTestId('account-status').first()).toHaveText('Connected');
  return section;
}

type Seen = { session: 'window' | 'measurer'; url: string; resourceType: string; allowed: boolean };
const seenRequests = (app: ElectronApplication) =>
  app.evaluate(() =>
    (
      globalThis as unknown as { commanderTestHooks: { emailRequests: () => Seen[] } }
    ).commanderTestHooks.emailRequests(),
  );
// What either session (the window's, with the email frames in it, or the measurer's) asked of anything
// but Commander's own protocols: nothing at all, ever.
const webRequests = async (app: ElectronApplication) =>
  (await seenRequests(app)).filter(
    (request) => !/^(?:commander-mail|attachment|data|blob):/i.test(request.url),
  );

const threads = (window: Page) => window.getByTestId('section-email').getByTestId('email-thread');
const reader = (window: Page) => window.getByTestId('section-email').getByRole('region', { name: 'Thread' });

// Opens a thread and waits for its frame to be sized to its content (so nothing moves under a click).
async function openThread(window: Page, subject: string) {
  await tab(window, 'Email').click();
  await threads(window).filter({ hasText: subject }).click();
  const frame = reader(window).getByTestId('email-frame');
  await expect(frame).toBeVisible();
  await expect(frame).not.toHaveCSS('height', '240px');
  return frame;
}

test('hostile email: no script runs, the window is untouched, nothing leaves until images are shown, links only to the browser', async () => {
  const hostile = [
    '<p>Hostile marker</p>',
    // Scripts that would only touch the frame's own document.
    '<script>document.body.setAttribute("data-script-ran", "1")</script>',
    '<img src="x" onerror="document.body.setAttribute(\'data-script-ran\', \'1\')">',
    "<svg onload=\"document.body.setAttribute('data-script-ran', '1')\"></svg>",
    '<p><a href="https://example.com/real-destination">https://bank.example.com/login</a></p>',
    `<img src="${trackerBase}/open.gif?u=1" width="40" height="40" alt="pixel">`,
    ...Object.values(HOSTILE).map((html) => html.replaceAll('https://tracker.test', trackerBase)),
  ].join('\n');
  google.gmail.deliver(ALEX.email, {
    from: 'Hostile Sender <attacker@evil.test>',
    to: ALEX.email,
    subject: 'Hostile HTML',
    text: 'Hostile marker',
    html: hostile,
    date: Date.now() - 60_000,
  });
  commander = await launchCommander({ env: environment() });
  const { app } = commander;
  const window = await commander.window();
  await standInForTheBrowser(app);
  await connect(window, 'google');

  // Gmail Accounts show images by default: ask first, so they are held back.
  const askFirst = window.getByRole('switch', {
    name: new RegExp(`^Ask before showing images for .*${ALEX.email}`),
  });
  await expect(askFirst).toBeVisible();
  await askFirst.click();
  await expect(askFirst).toHaveAttribute('aria-checked', 'true');
  await window.keyboard.press('Escape');

  const before = await window.evaluate(() => ({ title: document.title, url: location.href }));
  const frame = await openThread(window, 'Hostile HTML');
  await expect(frame).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  const src = (await frame.getAttribute('src')) as string;
  expect(src).toMatch(/^commander-mail:\/\/message\/[0-9a-f]{32}$/);
  const inside = window.frameLocator('[data-testid="email-frame"]');
  await expect(inside.getByText('Hostile marker')).toBeVisible();
  // Sized to its content, not left at its first height.
  await expect.poll(async () => (await frame.boundingBox())?.height ?? 0).toBeGreaterThan(300);
  await expect(reader(window).getByTestId('email-images-bar')).toContainText('held back');

  // Give anything that could run or load time to.
  await window.waitForTimeout(2000);
  expect(await window.evaluate(() => ({ title: document.title, url: location.href }))).toEqual(before);
  expect(await window.evaluate(() => (window as unknown as { pwned?: unknown }).pwned)).toBeUndefined();
  await expect(inside.locator('[data-script-ran]')).toHaveCount(0);
  await expect(
    inside.locator('script, iframe, object, embed, form, svg, math, meta[http-equiv], base, link'),
  ).toHaveCount(0);
  expect(hits).toEqual([]);
  // The measurer laid the document out too, and asked for nothing either.
  expect((await seenRequests(app)).some((request) => request.session === 'measurer')).toBe(true);
  expect(await webRequests(app)).toEqual([]);

  // The link's real destination shows on hover, and a click hands it to the system browser; the frame
  // stays where it is.
  const link = inside.getByRole('link', { name: 'https://bank.example.com/login' });
  await link.hover();
  await expect(reader(window).getByTestId('email-link-target')).toHaveText(
    '→ https://example.com/real-destination',
  );
  // Playwright's own scrolling can leave the link at the bottom, under the sticky line that shows its
  // destination: the frame is scrolled to the middle of the window first.
  await frame.evaluate((element) => globalThis.scrollBy(0, element.getBoundingClientRect().top - 300));
  await link.click();
  await expect.poll(() => openedInBrowser(app)).toEqual(['https://example.com/real-destination']);
  const frames = () => window.frames().map((each) => each.url());
  expect(frames()).toContain(src);
  // A javascript: link is only text.
  await expect(inside.locator('a[href^="javascript"]')).toHaveCount(0);

  // Show images: they load through the main process (the window's session still sees no web request),
  // and only what the email shows as an image (img, background, CSS url()) is asked for: never a
  // script, style sheet, font, frame, form, refresh, ping, media, or a URL hidden from the sanitiser.
  await reader(window).getByTestId('email-images-bar').getByRole('button', { name: 'Show images' }).click();
  await expect(reader(window).getByTestId('email-images-bar')).toHaveCount(0);
  // Exactly the images the sanitiser named are fetched (all of them, at once), and nothing else.
  const expected = sanitizeEmailHtml(hostile, {
    images: 'shown',
    quotes: false,
    imageUrl: String,
    partUrl: String,
  }).remoteImages.map((url) => url.slice(trackerBase.length).split('#')[0] as string);
  await expect.poll(() => [...new Set(hits)].sort()).toEqual([...new Set(expected)].sort());
  await window.waitForTimeout(1000);
  expect([...new Set(hits)].sort()).toEqual([...new Set(expected)].sort());
  expect(hits.some((hit) => hit.startsWith('/open.gif'))).toBe(true);
  // Never a script, style sheet, font, frame, form, refresh, ping, media, srcset, SVG or VML image,
  // object, or a URL hidden from the sanitiser.
  for (const forbidden of [
    '/x.js',
    '/steal',
    '/fa',
    '/fb',
    '/b',
    '/refresh',
    '/s.css',
    '/i.css',
    '/j.css',
    '/m.css',
    '/x.css',
    '/esc-import.css',
    '/comment.css',
    '/font.woff2',
    '/frame',
    '/ping',
    '/f1',
    '/portal',
    '/area',
    '/v.mp4',
    '/a.mp3',
    '/s.mp4',
    '/t.vtt',
    '/poster.png',
    '/s1.png',
    '/s2.png',
    '/p.webp',
    '/svg.png',
    '/svg2.png',
    '/sprite.svg',
    '/vml.png',
    '/vml2.png',
    '/l.png',
    '/d.avi',
    '/ld',
    '/o.swf',
    '/p.swf',
    '/e.swf',
    '/input.png',
    '/data.png',
    '/isindex',
    '/prefetch',
    '/preconnect',
    '/dns-prefetch',
    '/preload',
    '/icon',
    '/manifest',
    '/m.appcache',
    '/cite',
    '/q',
    '/var.png',
    '/v2.png',
    '/attr.png',
    '/esc1',
    '/esc2',
    '/esc3',
    '/comment.png',
    '/prop.png',
    '/sym.png',
    '/ns',
  ])
    expect(
      hits.map((hit) => hit.split(/[?#]/)[0]),
      forbidden,
    ).not.toContain(forbidden);
  // The images render (from the main process's fetch).
  await expect
    .poll(() => inside.locator('img[alt="pixel"]').evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  expect(await webRequests(app)).toEqual([]);
  expect(await window.evaluate(() => document.title)).toBe(before.title);
});

test('the frame holds on its own: unsanitised hostile HTML in it runs no script and reaches nothing', async () => {
  commander = await launchCommander({ env: environment() });
  const { app } = commander;
  const window = await commander.window();
  // Served as it is, without the sanitiser (a test hook), to show the other layers hold by themselves:
  // the frame's sandbox, the document's CSP and the session's request guard.
  const raw = [
    '<p>Unsanitised</p>',
    '<script>document.body.setAttribute("data-script-ran", "1"); parent.document.title = "pwned"</script>',
    '<img src="x" onerror="document.body.setAttribute(\'data-script-ran\', \'1\')">',
    `<img src="${trackerBase}/raw-pixel.png"><link rel="stylesheet" href="${trackerBase}/raw.css">`,
    `<style>@import url(${trackerBase}/raw-import.css); body { background: url(${trackerBase}/raw-bg.png) }</style>`,
    `<iframe src="${trackerBase}/raw-frame"></iframe><form action="${trackerBase}/raw-form"><input name="q"></form>`,
    `<meta http-equiv="refresh" content="0;url=${trackerBase}/raw-refresh">`,
    '<a id="away" href="https://example.com/raw">link without a target</a>',
  ].join('\n');
  const url = await app.evaluate(
    (_electron, html) =>
      (
        globalThis as unknown as { commanderTestHooks: { prepareUnsanitisedEmail: (html: string) => string } }
      ).commanderTestHooks.prepareUnsanitisedEmail(html),
    raw,
  );
  const title = await window.evaluate(() => document.title);
  await window.evaluate((src) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
    frame.setAttribute('data-testid', 'raw-frame');
    frame.src = src;
    document.body.append(frame);
  }, url);
  const inside = window.frameLocator('[data-testid="raw-frame"]');
  await expect(inside.getByText('Unsanitised')).toBeVisible();
  await window.waitForTimeout(2000);
  await expect(inside.locator('[data-script-ran]')).toHaveCount(0);
  expect(await window.evaluate(() => document.title)).toBe(title);
  expect(hits).toEqual([]);
  // A link without a target can't take the frame anywhere: the window's own CSP refuses the
  // navigation (the frame shows Chromium's blocked page), so nothing is fetched or opened.
  await inside.locator('#away').click();
  await window.waitForTimeout(1000);
  expect(window.frames().map((frame) => frame.url())).not.toContain('https://example.com/raw');
  expect(hits).toEqual([]);
  expect(await webRequests(app)).toEqual([]);
});

test('inline images and attachments: shown from the message’s own parts, saved, opened (programs only saved), and gone with the Account', async () => {
  google.gmail.deliver(ALEX.email, {
    from: 'Shop <orders@shop.test>',
    to: ALEX.email,
    subject: 'Your agenda',
    text: 'See the agenda.',
    html: `<p>Agenda inside</p><img src="cid:logo@shop.test" alt="logo"><img src="${trackerBase}/hero.png" alt="hero">`,
    date: Date.now() - 60_000,
    attachments: [
      { name: 'logo.png', type: 'image/png', content: PNG, contentId: 'logo@shop.test', inline: true },
      { name: 'Agenda.pdf', type: 'application/pdf', content: PDF },
      { name: 'setup.exe', type: 'application/x-msdownload', content: 'MZ not really' },
    ],
  });
  commander = await launchCommander({ env: environment() });
  const { app, userDataDir } = commander;
  const window = await commander.window();
  await standInForTheBrowser(app);
  await connect(window, 'google');
  await window.keyboard.press('Escape');

  await openThread(window, 'Your agenda');
  const inside = window.frameLocator('[data-testid="email-frame"]');
  await expect(inside.getByText('Agenda inside')).toBeVisible();
  // Gmail shows remote images by default, through the main process.
  await expect.poll(() => hits).toContain('/hero.png');
  // The inline image came from the message's own part, fetched once through Gmail and cached, and
  // shows; so does the remote one.
  for (const alt of ['logo', 'hero'])
    await expect
      .poll(() =>
        inside.locator(`img[alt="${alt}"]`).evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
  await expect
    .poll(() => google.gmail.requests.filter((path) => /\/attachments\/att-[^/]+-1$/.test(path)).length)
    .toBe(1);
  const parts = join(userDataDir, 'email-parts');
  expect(existsSync(parts)).toBe(true);
  expect(await webRequests(app)).toEqual([]);

  // Attachments: Save… (through the system save dialog) and Open (the system's default app).
  const saveDir = mkdtempSync(join(tmpdir(), 'commander-e2e-save-'));
  await app.evaluate(({ dialog, shell }, target) => {
    const opened: string[] = [];
    Object.assign(globalThis, { openedPaths: opened });
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      const options = args.at(-1) as { defaultPath?: string };
      const name = (options.defaultPath ?? 'x').split('/').pop() as string;
      return { canceled: false, filePath: `${target}/${name}` };
    }) as typeof dialog.showSaveDialog;
    shell.openPath = async (path: string) => {
      opened.push(path);
      return '';
    };
  }, saveDir);
  const rows = reader(window).getByTestId('email-attachment');
  await expect(rows).toHaveCount(2);
  await reader(window).getByRole('button', { name: 'Save Agenda.pdf' }).click();
  await expect.poll(() => existsSync(join(saveDir, 'Agenda.pdf'))).toBe(true);
  expect(readFileSync(join(saveDir, 'Agenda.pdf'))).toEqual(PDF);
  await reader(window).getByRole('button', { name: 'Open Agenda.pdf' }).click();
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { openedPaths: string[] }).openedPaths))
    .toEqual([expect.stringMatching(/email-parts\/[0-9a-f]+\/[0-9a-f]+\/Agenda\.pdf$/)]);
  await expect(reader(window).getByRole('button', { name: 'Save setup.exe' })).toBeVisible();
  await expect(reader(window).getByRole('button', { name: 'Open setup.exe' })).toHaveCount(0);
  rmSync(saveDir, { recursive: true, force: true });

  // Removing the Account removes its cached parts.
  const cachedBefore = readdirSync(parts);
  expect(cachedBefore.length).toBe(1);
  await openSettings(window);
  const section = window.getByTestId('accounts-panel').getByTestId('source-google');
  await section
    .getByRole('button', { name: /Remove/ })
    .first()
    .click();
  const confirm = window.getByRole('button', { name: /^Remove/ }).last();
  if (await confirm.isVisible()) await confirm.click();
  await expect.poll(() => readdirSync(parts)).toEqual([]);
});

test('Outlook Accounts hold images back: Show images and Always show from this sender work, persist, and are removable in Settings', async () => {
  test.setTimeout(90_000);
  microsoft = await startFakeMicrosoft();
  // Outlook mail syncs from the fake Graph (#136).
  for (const [id, subject] of [
    ['o1', 'Outlook first'],
    ['o2', 'Outlook second'],
  ] as const)
    microsoft.mail.deliver(SAM.id, {
      from: { name: 'Shop', address: 'news@shop.test' },
      to: [{ name: SAM.displayName, address: SAM.userPrincipalName }],
      subject,
      html: `<p>${subject}</p><img src="${trackerBase}/${id}.png" width="20" height="20">`,
      date: Date.now() - 60_000,
    });
  commander = await launchCommander({ env: environment() });
  const { app, userDataDir } = commander;
  let window = await commander.window();
  await standInForTheBrowser(app);
  await connect(window, 'google');
  await connect(window, 'outlook');
  await window.keyboard.press('Escape');

  await openThread(window, 'Outlook first');
  const bar = reader(window).getByTestId('email-images-bar');
  await expect(bar).toContainText('1 image held back');
  await window.waitForTimeout(1000);
  expect(hits).toEqual([]);
  await bar.getByRole('button', { name: 'Show images' }).click();
  await expect.poll(() => hits).toEqual(['/o1.png']);

  await openThread(window, 'Outlook second');
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Always show from this sender' }).click();
  await expect(bar).toHaveCount(0);
  await expect.poll(() => hits).toContain('/o2.png');

  // Both choices persist across a restart.
  await commander.app.close();
  commander = await launchCommander({ userDataDir, env: environment() });
  window = await commander.window();
  await openThread(window, 'Outlook first');
  await expect(reader(window).getByTestId('email-frame')).toBeVisible();
  await expect(reader(window).getByTestId('email-images-bar')).toHaveCount(0);
  await openThread(window, 'Outlook second');
  await expect(reader(window).getByTestId('email-images-bar')).toHaveCount(0);

  // The trusted sender is listed in Settings → Email, and can be removed.
  await openSettings(window);
  const settings = window.getByTestId('email-settings');
  await expect(settings.getByTestId('trusted-sender')).toHaveText(/news@shop\.test/);
  await settings.getByRole('button', { name: 'Stop always showing images from news@shop.test' }).click();
  await expect(settings.getByTestId('trusted-sender')).toHaveCount(0);
  await window.keyboard.press('Escape');
  await tab(window, 'Email').click();
  await threads(window).filter({ hasText: 'Outlook first' }).click();
  await threads(window).filter({ hasText: 'Outlook second' }).click();
  await expect(reader(window).getByTestId('email-images-bar')).toContainText('held back');
});
