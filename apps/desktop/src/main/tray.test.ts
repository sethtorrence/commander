import { describe, expect, it, vi } from 'vitest';
import { trayIconBitmap, trayMenuTemplate, trayToolTip } from './tray';

describe('trayMenuTemplate', () => {
  it('offers Open, Ask for an update and Quit, wired to their actions', () => {
    const onOpen = vi.fn();
    const onAskForUpdate = vi.fn();
    const onQuit = vi.fn();
    const items = trayMenuTemplate({ onOpen, onAskForUpdate, onQuit, queued: 0 }).filter(
      (item) => item.type !== 'separator',
    );
    expect(items.map((item) => item.label)).toEqual([
      'Open Commander',
      'Ask for an update',
      'Quit Commander',
    ]);

    const click = (index: number) => (items[index]?.click as (() => void) | undefined)?.();
    click(0);
    expect(onOpen).toHaveBeenCalledOnce();
    click(1);
    expect(onAskForUpdate).toHaveBeenCalledOnce();
    click(2);
    expect(onQuit).toHaveBeenCalledOnce();
  });

  it('shows the quiet count of what Ares has queued', () => {
    const items = trayMenuTemplate({ onOpen() {}, onAskForUpdate() {}, onQuit() {}, queued: 3 });
    expect(items.map((item) => item.label)).toContain('Ask for an update (3 queued)');
  });
});

describe('trayToolTip', () => {
  it('says how many things Ares is holding, quietly', () => {
    expect(trayToolTip(0)).toBe('Commander');
    expect(trayToolTip(1)).toBe('Commander · Ares has 1 thing for you');
    expect(trayToolTip(12)).toBe('Commander · Ares has 12 things for you');
  });
});

describe('trayIconBitmap', () => {
  it('is a square BGRA bitmap: international orange inside a dark frame', () => {
    const size = 32;
    const bitmap = trayIconBitmap(size);
    expect(bitmap.length).toBe(size * size * 4);
    const pixel = (x: number, y: number) => [...bitmap.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
    expect(pixel(0, 0)).toEqual([0x1b, 0x1c, 0x1e, 0xff]);
    expect(pixel(16, 16)).toEqual([0x00, 0x5f, 0xff, 0xff]); // #FF5F00 as B, G, R, A
  });

  it('carries the quiet count in a small badge in its corner, and none with nothing queued', () => {
    const size = 32;
    const light = [0xf2, 0xf2, 0xf2, 0xff];
    const lightPixels = (bitmap: Buffer) => {
      let count = 0;
      for (let at = 0; at < bitmap.length; at += 4) {
        if (bitmap[at] === 0xf2 && bitmap[at + 1] === 0xf2 && bitmap[at + 2] === 0xf2) count++;
      }
      return count;
    };
    expect(trayIconBitmap(size, 0).equals(trayIconBitmap(size))).toBe(true);
    expect(lightPixels(trayIconBitmap(size))).toBe(0);

    const three = trayIconBitmap(size, 3);
    expect(lightPixels(three)).toBeGreaterThan(0);
    // The badge sits in the bottom-right corner; the middle stays orange.
    const pixel = (x: number, y: number) => [...three.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
    expect(pixel(16, 8)).toEqual([0x00, 0x5f, 0xff, 0xff]);
    // "3" is drawn with a full top bar.
    expect(pixel(size - 6, size - 12)).toEqual(light);
    // More than nine reads "9+", which takes more room than one digit.
    expect(lightPixels(trayIconBitmap(size, 42))).toBeGreaterThan(lightPixels(three));
  });
});
