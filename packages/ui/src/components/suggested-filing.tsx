import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';
import type { AccentName } from '../projects/accents';
import { Badge } from './badge';
import { Button } from './button';

export type SuggestedFilingProps = Omit<ComponentProps<'span'>, 'children' | 'onChange'> & {
  /** The suggested Project's code, accent and name. */
  code: string;
  accent: AccentName | (string & {});
  project: string;
  /** Files the Item under the suggested Project, as the User. */
  onConfirm: () => void;
  /** Opens the Badge picker to choose another Project (or Unfiled). */
  onChange: () => void;
};

/**
 * Ares's suggested Project for an Item he wasn't sure about (#71): the dashed Badge, with Confirm
 * (files it there, by the User) and Change (opens the Badge picker). Rows show the dashed Badge
 * alone; a click on it, or `b`, opens the picker with Confirm at the top.
 */
export function SuggestedFiling({
  code,
  accent,
  project,
  onConfirm,
  onChange,
  className,
  ...props
}: SuggestedFilingProps) {
  return (
    <span
      data-slot="suggested-filing"
      className={cn('inline-flex items-center gap-1.5', className)}
      {...props}
    >
      <Badge kind="suggested" code={code} accent={accent} project={project} />
      <Button size="sm" variant="signal" aria-label={`Confirm ${project}`} onClick={onConfirm}>
        Confirm
      </Button>
      <Button size="sm" aria-label="Change the Project" onClick={onChange}>
        Change
      </Button>
    </span>
  );
}
