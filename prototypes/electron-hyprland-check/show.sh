#!/bin/sh
# PROTOTYPE: what a Hyprland bind runs for Commander. Wake the app (shows the window if it was hidden to the tray), then let Hyprland focus it.
"/tmp/commander-electron-check/prototypes/electron-hyprland-check/node_modules/.bin/electron" "/tmp/commander-electron-check/prototypes/electron-hyprland-check" --show
sleep 0.3
hyprctl dispatch 'hl.dsp.focus({ window = "class:prototype-electron-hyprland-check" })'
