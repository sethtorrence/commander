/*
  Pasted images (attachments): files in the `attachments/` folder next to the database, each named
  by the SHA-256 of its bytes. A Block holding an image stores it as Markdown, `![](attachments/<name>)`,
  so the Daily Note's Markdown copy can carry it as it is. The window shows the file through the
  `attachment://local/<name>` protocol, which the main process serves from that folder alone.
*/

/** The image types that can be attached, by file extension. SVG is left out: it can carry script. */
export const attachmentTypes = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
} as const;
export type AttachmentExtension = keyof typeof attachmentTypes;

/** The largest image that can be attached. */
export const attachmentMaxBytes = 20 * 1024 * 1024;

export const attachmentNamePattern = /^[0-9a-f]{64}\.(?:png|jpg|gif|webp)$/;

export const isAttachmentName = (name: string): boolean => attachmentNamePattern.test(name);

/** The Block text for an image Block. */
export const attachmentMarkdown = (name: string): string => `![](attachments/${name})`;

const NAME = '[0-9a-f]{64}\\.(?:png|jpg|gif|webp)';
const imageBlock = new RegExp(`^!\\[[^\\]\\n]*\\]\\(attachments/(${NAME})\\)$`);
const imageRef = new RegExp(`!\\[[^\\]\\n]*\\]\\(attachments/(${NAME})\\)`, 'g');

/** The attachment an image Block shows: its whole text is one attachment image. Null otherwise. */
export function imageAttachmentOf(text: string): string | null {
  return imageBlock.exec(text)?.[1] ?? null;
}

/** Every attachment a Block's text refers to, in order. */
export function attachmentsIn(text: string): string[] {
  return [...text.matchAll(imageRef)].map((match) => match[1] as string);
}

export const attachmentScheme = 'attachment';

/** Where the window loads an attachment from. */
export const attachmentUrl = (name: string): string => `${attachmentScheme}://local/${name}`;

/**
 * The attachment an `attachment://local/<name>` URL asks for, or null for anything else. Only that
 * exact form is accepted (no dot segments, escapes, query or other host), so it can't reach past
 * the folder.
 */
export function attachmentFromUrl(url: string): string | null {
  const prefix = attachmentUrl('');
  if (!url.startsWith(prefix)) return null;
  const name = url.slice(prefix.length);
  return isAttachmentName(name) ? name : null;
}
