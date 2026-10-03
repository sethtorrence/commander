#!/bin/sh
# PROTOTYPE: fast Hyprland bind for Commander. Signal the running app to show itself, then let Hyprland focus it.
kill -USR1 "$(cat "/tmp/commander-electron-check/prototypes/electron-hyprland-check/app.pid")" && sleep 0.05
hyprctl dispatch 'hl.dsp.focus({ window = "class:prototype-electron-hyprland-check" })' >/dev/null
