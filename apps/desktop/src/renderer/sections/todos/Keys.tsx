import { Kbd } from '@commander/ui';
import type { ReactNode } from 'react';

const KEYS: [ReactNode, string][] = [
  [
    <>
      <Kbd>J</Kbd>
      <Kbd>K</Kbd>
    </>,
    'Move',
  ],
  [<Kbd key="enter">↵</Kbd>, 'Open'],
  [<Kbd key="x">X</Kbd>, 'Tick'],
  [<Kbd key="del">Del</Kbd>, 'Delete'],
  [<Kbd key="n">N</Kbd>, 'New'],
  [<Kbd key="z">Ctrl Z</Kbd>, 'Undo'],
  [<Kbd key="b">B</Kbd>, 'Project'],
  [<Kbd key="l">L</Kbd>, 'Linear'],
];

/** The Section's main keys at a glance, beside its title. All of them are in the `?` cheat sheet. */
export function Keys() {
  return (
    <div className="grid grid-cols-[auto_auto] gap-x-3.5 gap-y-[5px] pb-0.5 font-mono text-label leading-[19px] font-medium uppercase tracking-label whitespace-nowrap text-muted [&_kbd]:h-[17px] [&_kbd]:min-w-[17px] [&_kbd]:text-label">
      {KEYS.map(([caps, label]) => (
        <span key={label} className="flex items-center gap-[7px]">
          {caps} {label}
        </span>
      ))}
    </div>
  );
}
