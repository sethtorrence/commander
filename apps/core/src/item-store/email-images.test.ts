import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// The email reader's image rules (#134), kept in the Item store's database so they survive restarts.

let dir: string;
let store: ItemStore;
const open = () =>
  openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => 1_000,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-email-images-'));
  store = open();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('email image rules', () => {
  it('starts with nothing: no Account asks first, no sender or message is trusted', () => {
    expect(store.emailImages.askFirst('google:1')).toBe(false);
    expect(store.emailImages.senderTrusted('google:1', 'dana@example.com')).toBe(false);
    expect(store.emailImages.messageShown('google:1', 'item-1')).toBe(false);
    expect(store.emailImages.trustedSenders('google:1')).toEqual([]);
  });

  it('keeps Ask before showing images per Account, across a restart', () => {
    store.emailImages.setAskFirst('google:1', true);
    store.close();
    store = open();
    expect(store.emailImages.askFirst('google:1')).toBe(true);
    expect(store.emailImages.askFirst('google:2')).toBe(false);
    store.emailImages.setAskFirst('google:1', false);
    expect(store.emailImages.askFirst('google:1')).toBe(false);
  });

  it('trusts senders by address, whatever its case, per Account, until untrusted', () => {
    store.emailImages.trustSender('outlook:1', 'Dana@Example.com');
    store.emailImages.trustSender('outlook:1', 'dana@example.com');
    store.emailImages.trustSender('outlook:1', 'news@shop.test');
    expect(store.emailImages.senderTrusted('outlook:1', 'DANA@example.com')).toBe(true);
    expect(store.emailImages.senderTrusted('outlook:2', 'dana@example.com')).toBe(false);
    expect(store.emailImages.trustedSenders('outlook:1')).toEqual(['dana@example.com', 'news@shop.test']);
    store.close();
    store = open();
    store.emailImages.untrustSender('outlook:1', 'DANA@example.com');
    expect(store.emailImages.trustedSenders('outlook:1')).toEqual(['news@shop.test']);
  });

  it('remembers Show images per message', () => {
    store.emailImages.showMessage('outlook:1', 'item-9');
    store.close();
    store = open();
    expect(store.emailImages.messageShown('outlook:1', 'item-9')).toBe(true);
    expect(store.emailImages.messageShown('outlook:1', 'item-8')).toBe(false);
  });

  it('forgets everything about an Account when it is removed', () => {
    store.emailImages.setAskFirst('google:1', true);
    store.emailImages.trustSender('google:1', 'a@b.test');
    store.emailImages.showMessage('google:1', 'item-1');
    store.emailImages.trustSender('google:2', 'a@b.test');
    store.emailImages.removeAccount('google:1');
    expect(store.emailImages.askFirst('google:1')).toBe(false);
    expect(store.emailImages.trustedSenders('google:1')).toEqual([]);
    expect(store.emailImages.messageShown('google:1', 'item-1')).toBe(false);
    expect(store.emailImages.trustedSenders('google:2')).toEqual(['a@b.test']);
  });
});
