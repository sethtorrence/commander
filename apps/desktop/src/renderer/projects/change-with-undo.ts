import type { ProjectAction, ProjectChange } from '@commander/domain';
import { toast } from '@commander/ui';
import type { ProjectsApi } from './context';

export const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/**
 * Makes a Project change (from Settings or a Project page) and says what happened in a toast with
 * Undo, which reverses it through the Project log. `after` runs once the change, or its undo, is
 * made, to reload what it touched. A refusal goes to `refused` (a toast by default). Resolves with
 * the change, or null when it was refused.
 */
export async function changeWithUndo(
  change: ProjectsApi['change'],
  action: ProjectAction,
  said: string | ((done: ProjectChange) => string),
  {
    after,
    refused = (message) => toast(message),
  }: { after?: () => void; refused?: (message: string) => void } = {},
): Promise<ProjectChange | null> {
  let done: ProjectChange;
  try {
    done = await change(action);
  } catch (reason) {
    refused(errorText(reason));
    return null;
  }
  after?.();
  toast(typeof said === 'string' ? said : said(done), {
    action: {
      label: 'Undo',
      onClick: () =>
        change({ type: 'undo', changeId: done.id }).then(
          () => after?.(),
          (reason: unknown) => toast(errorText(reason)),
        ),
    },
  });
  return done;
}
