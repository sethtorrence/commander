import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge Commander's theme names, so `text-label` (a size) and `text-muted`
// (a colour) don't cancel each other out.
const twMerge = extendTailwindMerge({
  // Commander's text sizes carry no line height, so a size must not cancel a `leading-*` class.
  override: { conflictingClassGroups: { 'font-size': [] } },
  extend: {
    theme: {
      text: [
        'micro',
        'tiny',
        'label',
        'label-lg',
        'kbd',
        'clock',
        'code',
        'code-lg',
        'small',
        'note',
        'heading',
        'ui',
        'row',
        'body',
        'intro',
        'lead',
        'figure',
        'subtitle',
        'count',
        'title',
        'display-sm',
        'display',
      ],
      tracking: ['display', 'body', 'mono', 'code', 'badge', 'heading', 'tag', 'label', 'caps', 'wide'],
      leading: ['none', 'display', 'tight', 'body'],
      color: [
        'bg',
        'sheet',
        'raise',
        'ink',
        'text',
        'muted',
        'faint',
        'line',
        'line2',
        'hatch',
        'signal',
        'on-signal',
        'signal-ink',
        'signal-soft',
        'signal-focus',
        'on-accent',
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
