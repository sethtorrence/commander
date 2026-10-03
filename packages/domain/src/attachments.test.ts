import { describe, expect, it } from 'vitest';
import {
  attachmentFromUrl,
  attachmentMarkdown,
  attachmentsIn,
  attachmentUrl,
  imageAttachmentOf,
  isAttachmentName,
} from './attachments';

const hash = 'a'.repeat(64);

describe('attachment names', () => {
  it('are a SHA-256 in hex with an image extension', () => {
    expect(isAttachmentName(`${hash}.png`)).toBe(true);
    expect(isAttachmentName(`${hash}.jpg`)).toBe(true);
    expect(isAttachmentName(`${hash}.gif`)).toBe(true);
    expect(isAttachmentName(`${hash}.webp`)).toBe(true);
  });

  it.each([
    `${hash}.svg`,
    `${hash}.PNG`,
    `${'A'.repeat(64)}.png`,
    `${hash.slice(1)}.png`,
    `../${hash}.png`,
    `${hash}.png/..`,
    `x/${hash}.png`,
    '',
  ])('refuse %j', (name) => {
    expect(isAttachmentName(name)).toBe(false);
  });
});

describe('an image Block', () => {
  it('stores the image as Markdown pointing into attachments/', () => {
    expect(attachmentMarkdown(`${hash}.png`)).toBe(`![](attachments/${hash}.png)`);
  });

  it('is a Block whose whole text is one attachment image', () => {
    expect(imageAttachmentOf(`![](attachments/${hash}.png)`)).toBe(`${hash}.png`);
    expect(imageAttachmentOf(`![A chart](attachments/${hash}.jpg)`)).toBe(`${hash}.jpg`);
    expect(imageAttachmentOf(`see ![](attachments/${hash}.png)`)).toBeNull();
    expect(imageAttachmentOf(`![](attachments/${hash}.png) and more`)).toBeNull();
    expect(imageAttachmentOf('![](https://example.com/a.png)')).toBeNull();
    expect(imageAttachmentOf(`![](attachments/../${hash}.png)`)).toBeNull();
  });

  it('finds every attachment a text refers to', () => {
    const other = 'b'.repeat(64);
    expect(attachmentsIn(`![](attachments/${hash}.png) and ![x](attachments/${other}.webp)`)).toEqual([
      `${hash}.png`,
      `${other}.webp`,
    ]);
    expect(attachmentsIn('no images here')).toEqual([]);
  });
});

describe('attachment URLs', () => {
  it('go through the attachment protocol and back', () => {
    expect(attachmentUrl(`${hash}.png`)).toBe(`attachment://local/${hash}.png`);
    expect(attachmentFromUrl(`attachment://local/${hash}.png`)).toBe(`${hash}.png`);
  });

  it.each([
    `attachment://local/../${hash}.png`,
    `attachment://local/..%2F${hash}.png`,
    `attachment://local/%2e%2e/${hash}.png`,
    `attachment://other/${hash}.png`,
    `attachment://local/sub/${hash}.png`,
    `attachment://local/${hash}.png?x=1`,
    `attachment://local/${hash}.png#x`,
    `file:///tmp/${hash}.png`,
    `https://local/${hash}.png`,
    'attachment://local/commander.db',
    'not a url',
  ])('refuse %j', (url) => {
    expect(attachmentFromUrl(url)).toBeNull();
  });
});
