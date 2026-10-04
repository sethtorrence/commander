import { describe, expect, it } from 'vitest';
import {
  emailImageUrl,
  emailMessageUrl,
  emailPartUrl,
  emailReaderUrlOf,
  isOpenableAttachment,
  safeAttachmentName,
  safeMailto,
} from './email-reader';

const TOKEN = '0123456789abcdef0123456789abcdef';

describe('email reader URLs', () => {
  it('round-trips a message, a remote image and an inline part', () => {
    expect(emailReaderUrlOf(emailMessageUrl(TOKEN))).toEqual({ kind: 'message', token: TOKEN });
    expect(emailReaderUrlOf(emailImageUrl(TOKEN, 7))).toEqual({ kind: 'image', token: TOKEN, index: 7 });
    expect(emailReaderUrlOf(emailPartUrl(TOKEN, 'logo@shop.test'))).toEqual({
      kind: 'part',
      token: TOKEN,
      contentId: 'logo@shop.test',
    });
    // Content-IDs may hold anything; they travel percent-encoded.
    const odd = 'a/b?c#d e%f<g>';
    expect(emailReaderUrlOf(emailPartUrl(TOKEN, odd))).toEqual({
      kind: 'part',
      token: TOKEN,
      contentId: odd,
    });
  });

  it('accepts nothing but those exact forms', () => {
    for (const url of [
      'commander-mail://message/',
      'commander-mail://message/0123',
      `commander-mail://message/${TOKEN.toUpperCase()}`,
      `commander-mail://message/${TOKEN}/extra`,
      `commander-mail://message/${TOKEN}?x=1`,
      `commander-mail://message/${TOKEN}#x`,
      `commander-mail://MESSAGE/${TOKEN}`,
      `commander-mail://image/${TOKEN}/`,
      `commander-mail://image/${TOKEN}/-1`,
      `commander-mail://image/${TOKEN}/01`,
      `commander-mail://image/${TOKEN}/1.5`,
      `commander-mail://image/${TOKEN}/100000`,
      `commander-mail://part/${TOKEN}/`,
      `commander-mail://part/${TOKEN}/%E0%A4%A`,
      `commander-mail://part/${TOKEN}/../x`,
      `commander-mail://other/${TOKEN}`,
      `attachment://local/${TOKEN}`,
      `https://example.com/${TOKEN}`,
      'not a url',
    ]) {
      expect(emailReaderUrlOf(url), url).toBeNull();
    }
  });
});

describe('mailto: links', () => {
  it('keeps the addresses, subject, body, cc and bcc, and drops anything else', () => {
    expect(safeMailto('mailto:help@shop.test')).toBe('mailto:help@shop.test');
    expect(safeMailto('mailto:a@x.test?subject=Hi%20there&body=Line&cc=b@x.test&bcc=c@x.test')).toBe(
      'mailto:a@x.test?subject=Hi%20there&body=Line&cc=b@x.test&bcc=c@x.test',
    );
    expect(safeMailto('mailto:a@x.test?attach=/home/me/.ssh/id_rsa&subject=x')).toBe(
      'mailto:a@x.test?subject=x',
    );
    expect(safeMailto('mailto:a@x.test?ATTACHMENT=~/.gnupg&X-Evil=1')).toBe('mailto:a@x.test');
    expect(safeMailto('https://x.test/')).toBeNull();
  });
});

describe('attachment names', () => {
  it('keeps a plain name and its extension', () => {
    expect(safeAttachmentName('Invoice 2026-10.pdf')).toBe('Invoice 2026-10.pdf');
  });

  it('takes away paths, control characters, leading dots and reserved characters', () => {
    expect(safeAttachmentName('../../etc/passwd')).toBe('passwd');
    expect(safeAttachmentName('C:\\Users\\me\\evil.exe')).toBe('evil.exe');
    expect(safeAttachmentName('.bashrc')).toBe('bashrc');
    expect(safeAttachmentName('a\u0000b\u0007c\n.txt')).toBe('abc.txt');
    expect(safeAttachmentName('re<po>rt:"x"|?*.pdf')).toBe('re_po_rt__x____.pdf');
    // Right-to-left override makes "gnp.exe" look like "exe.png".
    expect(safeAttachmentName('photo\u202Egnp.exe')).toBe('photognp.exe');
    expect(safeAttachmentName('')).toBe('attachment');
    expect(safeAttachmentName('...')).toBe('attachment');
    expect(safeAttachmentName('report.pdf. . ')).toBe('report.pdf');
  });

  it('steers clear of the names Windows reserves for devices', () => {
    expect(safeAttachmentName('CON.pdf')).toBe('_CON.pdf');
    expect(safeAttachmentName('nul.txt')).toBe('_nul.txt');
    expect(safeAttachmentName('com1')).toBe('_com1');
    expect(safeAttachmentName('LPT9.docx')).toBe('_LPT9.docx');
    expect(safeAttachmentName('console.pdf')).toBe('console.pdf');
  });

  it('shortens a long name but keeps its extension', () => {
    const name = safeAttachmentName(`${'x'.repeat(300)}.docx`);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith('.docx')).toBe(true);
  });
});

describe('which attachments can be opened', () => {
  it('opens documents, images, audio and video', () => {
    for (const name of ['a.pdf', 'b.PNG', 'c.jpeg', 'd.docx', 'e.xlsx', 'f.txt', 'g.pptx', 'h.mp3', 'i.mp4'])
      expect(isOpenableAttachment(name, 'application/octet-stream'), name).toBe(true);
  });

  it('only saves programs, scripts, installers, archives, web pages and anything unknown', () => {
    for (const name of [
      'setup.exe',
      'run.sh',
      'x.desktop',
      'app.AppImage',
      'tool.jar',
      'script.js',
      'page.html',
      'page.htm',
      'image.svg',
      'macro.docm',
      'macro.xlsm',
      'archive.zip',
      'disk.iso',
      'pkg.deb',
      'win.msi',
      'link.lnk',
      'a.bat',
      'a.ps1',
      'a.py',
      'invite.ics',
      'old.doc',
      'old.xls',
      'old.ppt',
      'letter.rtf',
      'open.odt',
      'sheet.ods',
      'data.csv',
      'noextension',
      'double.pdf.exe',
    ])
      expect(isOpenableAttachment(name, 'application/pdf'), name).toBe(false);
  });

  it('only saves a file whose type says it is a program, whatever its name', () => {
    expect(isOpenableAttachment('report.pdf', 'application/x-msdownload')).toBe(false);
    expect(isOpenableAttachment('report.pdf', 'application/x-sh')).toBe(false);
    expect(isOpenableAttachment('report.pdf', 'text/html')).toBe(false);
    expect(isOpenableAttachment('report.pdf', 'application/pdf')).toBe(true);
  });
});
