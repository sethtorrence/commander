import { Menu, type MenuItemConstructorOptions, nativeImage, Tray } from 'electron';

// The tray icon is how Commander stays reachable while its window is hidden. On Hyprland it
// needs a StatusNotifierItem host in the bar (waybar's tray module, DankMaterialShell, ...). Its menu
// asks Ares for an Update, and it carries his quiet count of what is queued (in the menu and the
// tooltip): a count, never a pop-up.

type TrayActions = { onOpen: () => void; onAskForUpdate: () => void; onQuit: () => void };

export function trayMenuTemplate({
  onOpen,
  onAskForUpdate,
  onQuit,
  queued,
}: TrayActions & { queued: number }): MenuItemConstructorOptions[] {
  return [
    { label: 'Open Commander', click: onOpen },
    { label: queued ? `Ask for an update (${queued} queued)` : 'Ask for an update', click: onAskForUpdate },
    { type: 'separator' },
    { label: 'Quit Commander', click: onQuit },
  ];
}

export const trayToolTip = (queued: number) =>
  queued ? `Commander · Ares has ${queued} thing${queued === 1 ? '' : 's'} for you` : 'Commander';

export type CommanderTray = {
  tray: Tray;
  // Ares's queued count changed.
  setQueued(queued: number): void;
  // The menu as it stands, for the end-to-end tests' hook.
  menu(): MenuItemConstructorOptions[];
};

// Digits (and +) for the count badge, 3 by 5 pixels, row by row.
const GLYPHS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
};
const DARK = [0x1b, 0x1c, 0x1e, 0xff];
const ORANGE = [0x00, 0x5f, 0xff, 0xff];
const LIGHT = [0xf2, 0xf2, 0xf2, 0xff];

// Drawn in code so there is no asset to package: a square of international orange (#FF5F00)
// in a dark frame, in the Industrial look, with Ares's queued count in a small dark badge in the
// bottom-right corner when there is one ("9+" past nine). Chromium bitmaps are BGRA.
export function trayIconBitmap(size: number, queued = 0): Buffer {
  const frame = Math.max(2, Math.round(size / 11));
  const bitmap = Buffer.alloc(size * size * 4);
  const paint = (x: number, y: number, colour: number[]) => {
    if (x >= 0 && y >= 0 && x < size && y < size) bitmap.set(colour, (y * size + x) * 4);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edge = x < frame || y < frame || x >= size - frame || y >= size - frame;
      paint(x, y, edge ? DARK : ORANGE);
    }
  }
  if (queued <= 0) return bitmap;
  const text = queued > 9 ? '9+' : String(queued);
  const scale = Math.max(1, Math.floor(size / 16));
  const width = text.length * 3 * scale + (text.length - 1) * scale;
  const left = size - width - 2 * scale;
  const top = size - 7 * scale;
  for (let y = top; y < size; y++) for (let x = left; x < size; x++) paint(x, y, DARK);
  [...text].forEach((char, index) => {
    const originX = left + scale + index * 4 * scale;
    (GLYPHS[char] ?? []).forEach((row, gy) => {
      [...row].forEach((bit, gx) => {
        if (bit !== '1') return;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            paint(originX + gx * scale + dx, top + scale + gy * scale + dy, LIGHT);
          }
        }
      });
    });
  });
  return bitmap;
}

export function createTray(actions: TrayActions): CommanderTray {
  const size = 32;
  const icon = (count: number) =>
    nativeImage.createFromBitmap(trayIconBitmap(size, count), { width: size, height: size });
  const tray = new Tray(icon(0));
  let queued = 0;
  const menu = () => trayMenuTemplate({ ...actions, queued });
  const draw = () => {
    tray.setImage(icon(queued));
    tray.setToolTip(trayToolTip(queued));
    tray.setContextMenu(Menu.buildFromTemplate(menu()));
  };
  draw();
  tray.on('click', actions.onOpen);
  return {
    tray,
    setQueued(next) {
      if (next === queued || tray.isDestroyed()) return;
      queued = next;
      draw();
    },
    menu,
  };
}
