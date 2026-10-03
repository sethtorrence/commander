import { Menu, type MenuItemConstructorOptions, nativeImage, Tray } from 'electron';

// The tray icon is how Commander stays reachable while its window is hidden. On Hyprland it
// needs a StatusNotifierItem host in the bar (waybar's tray module, DankMaterialShell, ...).

type TrayActions = { onOpen: () => void; onQuit: () => void };

export function trayMenuTemplate({ onOpen, onQuit }: TrayActions): MenuItemConstructorOptions[] {
  return [
    { label: 'Open Commander', click: onOpen },
    { type: 'separator' },
    { label: 'Quit Commander', click: onQuit },
  ];
}

// Drawn in code so there is no asset to package: a square of international orange (#FF5F00)
// in a dark frame, in the Industrial look. Chromium bitmaps are BGRA.
export function trayIconBitmap(size: number): Buffer {
  const frame = Math.max(2, Math.round(size / 11));
  const bitmap = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edge = x < frame || y < frame || x >= size - frame || y >= size - frame;
      bitmap.set(edge ? [0x1b, 0x1c, 0x1e, 0xff] : [0x00, 0x5f, 0xff, 0xff], (y * size + x) * 4);
    }
  }
  return bitmap;
}

export function createTray(actions: TrayActions): Tray {
  const size = 32;
  const tray = new Tray(nativeImage.createFromBitmap(trayIconBitmap(size), { width: size, height: size }));
  tray.setToolTip('Commander');
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(actions)));
  tray.on('click', actions.onOpen);
  return tray;
}
