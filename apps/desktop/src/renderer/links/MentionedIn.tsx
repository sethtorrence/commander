import './links.css';
import type { Mention } from '@commander/domain';
import { accentColour, accentTextColour, cn } from '@commander/ui';
import type { CSSProperties } from 'react';
import { type LabelChip, splitLinks } from './block-text';
import { shortDay } from './link-targets';

/** A Block's text as read, not edited: its `[[` tokens drawn as chips with their labels. */
export function ChipText({ text, label }: { text: string; label: LabelChip }) {
  return (
    <span className="min-w-0">
      {splitLinks(text).map((part, i) => {
        if (!part.target) return part.text;
        const shown = label(part.target);
        const style = shown.project
          ? ({
              '--accent': accentColour(shown.project.accent),
              '--on-chip': accentTextColour(shown.project.accent),
            } as CSSProperties)
          : undefined;
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: parts of one text, in order
            key={i}
            className="n-chip"
            data-chip={part.target.type}
            data-code={shown.project?.code}
            title={shown.title}
            style={style}
          >
            {shown.text}
          </span>
        );
      })}
    </span>
  );
}

export interface MentionsProps {
  mentions: readonly Mention[];
  today: string;
  label: LabelChip;
  onOpen(mention: Mention): void;
}

const textOf = (block: Mention['block']) =>
  block.detail?.kind === 'block' ? block.detail.text : block.title;

/** The mentions as rows: the day, then the Block's text with its chips. Each opens its Block. */
export function MentionRows({
  mentions,
  today,
  label,
  onOpen,
  className,
}: MentionsProps & { className?: string }) {
  return mentions.map((mention) => (
    <button
      key={`${mention.target.id}:${mention.block.id}`}
      type="button"
      className={cn('n-mention', className)}
      title="Show this Block in its Daily Note"
      onClick={() => onOpen(mention)}
    >
      <span className="when">{shortDay(mention.day, today)}</span>
      <ChipText text={textOf(mention.block)} label={label} />
    </button>
  ));
}

/**
 * "Mentioned in" at the foot of a day's sheet: the Blocks on other days whose `[[` links point at it,
 * newest day first. Nothing at all when there are none.
 */
export function MentionedIn(props: MentionsProps) {
  if (!props.mentions.length) return null;
  return (
    <section className="n-mentions" aria-label="Mentioned in" data-testid="mentioned-in">
      <div className="n-mentions-head">
        <span>Mentioned in</span>
        <span className="n">{String(props.mentions.length).padStart(2, '0')}</span>
      </div>
      <MentionRows {...props} />
    </section>
  );
}
