import { cn, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Kbd } from '@commander/ui';
import { useRef } from 'react';
import { useShortcutList } from '../shortcuts/react';
import type { ListedShortcut } from '../shortcuts/registry';

// How named keys are printed on their caps.
const CAPS: Record<string, string> = {
  Escape: 'Esc',
  Enter: '↵',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ' ': 'Space',
};

function groups(list: readonly ListedShortcut[]) {
  const byGroup = new Map<string, ListedShortcut[]>();
  for (const shortcut of list)
    byGroup.set(shortcut.group, [...(byGroup.get(shortcut.group) ?? []), shortcut]);
  return [...byGroup].map(([name, shortcuts]) => ({
    name,
    shortcuts,
    // A Section's own keys work only while it is open.
    elsewhere: shortcuts.every((s) => !s.active),
  }));
}

/** The `?` cheat sheet: every shortcut registered so far, grouped, laid out like the prototype's key card. */
export function CheatSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const list = useShortcutList();
  const content = useRef<HTMLDivElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(760px,calc(100vw-48px))]"
        data-testid="cheat-sheet"
        // Focus the sheet itself rather than its Close button, so it opens without a focus ring.
        ref={content}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          content.current?.focus();
        }}
      >
        <DialogHeader partNumber="KEY-01">
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <DialogDescription className="sr-only">Every key Commander knows so far.</DialogDescription>
        <div className="grid max-h-[calc(100vh-160px)] grid-cols-2 items-start gap-3.5 overflow-auto p-3.5">
          {groups(list).map((group) => (
            <section key={group.name} className="border border-line" aria-label={group.name}>
              <h3 className="m-0 flex h-7.5 items-center justify-between gap-2 border-b border-line px-2.5 font-mono text-label leading-none font-semibold uppercase tracking-label text-ink">
                {group.name}
                {group.elsewhere && <span className="font-medium text-faint">When open</span>}
              </h3>
              <dl className="m-0">
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={`${shortcut.scope ?? ''}:${shortcut.keys.join('+')}`}
                    className={cn(
                      'grid grid-cols-[84px_minmax(0,1fr)] items-center gap-2 border-b border-line2 px-2.5 py-[5px] text-note last:border-b-0',
                      !shortcut.active && 'opacity-60',
                    )}
                  >
                    <dt className="flex gap-1">
                      {shortcut.keys.map((key) => (
                        <Kbd key={key}>{CAPS[key] ?? key}</Kbd>
                      ))}
                    </dt>
                    <dd className="m-0 text-text">{shortcut.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
