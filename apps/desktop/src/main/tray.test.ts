import { describe, expect, it, vi } from 'vitest';
import { trayIconBitmap, trayMenuTemplate } from './tray';

describe('trayMenuTemplate', () => {
  it('offers Open and Quit, wired to their actions', () => {
    const onOpen = vi.fn();
    const onQuit = vi.fn();
    const items = trayMenuTemplate({ onOpen, onQuit }).filter((item) => item.type !== 'separator');
    expect(items.map((item) => item.label)).toEqual(['Open Commander', 'Quit Commander']);

    const click = (index: number) => (items[index]?.click as (() => void) | undefined)?.();
    click(0);
    expect(onOpen).toHaveBeenCalledOnce();
    click(1);
    expect(onQuit).toHaveBeenCalledOnce();
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
});
