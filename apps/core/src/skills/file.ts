// File (#196): the User tells Ares to file Items into one of their Projects from a Conversation ("file
// this under Longtail", "put the Relay PRs in Titanlink"), as the filing job files them: Organise, in
// each Item's own Section, filed by Ares (so he may file it again later, and the User's answer to it
// is a correction, as for the job's). Filing precedence holds: an Item the User or a Rule filed stays
// theirs, which the gate refuses too; Commander says so rather than trying.
import {
  CONVERSATION_FILE,
  FILE_NEEDS,
  FILE_SKILL,
  type FileInput,
  fileInput,
  type RegisteredAction,
  type Skill,
} from '@commander/domain';
import {
  type Acted,
  type ActionSkillOptions,
  acting,
  actionFindings,
  registerActions,
  sectionOfItem,
} from './act';
import { projectNamed } from './find';
import type { Findings } from './findings';

export const FILE_ACTION: RegisteredAction = {
  action: CONVERSATION_FILE,
  actionKind: 'organise',
  name: 'File',
  hint: 'Items Ares files into a Project when you tell him to in a Conversation',
};

const FILED_BY = { user: 'the User', rule: 'a Rule' } as const;

export function createFileSkill(options: ActionSkillOptions): Skill<FileInput, Findings> {
  const { itemStore, gate } = options;
  registerActions(gate, FILE_ACTION);
  const title = FILE_SKILL.title as string;

  return {
    ...FILE_SKILL,
    input: { schema: fileInput, describe: FILE_NEEDS },
    async run(input, context) {
      const act = acting(context ?? {}, options);
      const project = projectNamed(
        itemStore.projects().filter((each) => !each.archived),
        input.project,
      );
      if (!project) {
        return actionFindings(
          title,
          [],
          ['filing: none of the User’s Projects has the name or code you gave'],
        );
      }
      const where = `${project.code} · ${project.name}`;
      const acted: Acted[] = [];
      const skipped: string[] = [];
      for (const ref of new Set(input.items)) {
        const item = act.item(ref);
        if (item.kind === 'daily-note') {
          skipped.push(`${ref} is a Daily Note, which belongs to no Project`);
          continue;
        }
        const filing = item.filing;
        if (filing?.projectId === project.id) {
          skipped.push(`${ref} is already filed under ${where}`);
          continue;
        }
        if (filing?.filedBy === 'user' || filing?.filedBy === 'rule') {
          skipped.push(`filing ${ref}: ${FILED_BY[filing.filedBy]} filed it, so it stays where it is`);
          continue;
        }
        acted.push(
          act.propose({
            what: `file ${ref} under ${where}`,
            proposal: {
              actionKind: 'organise',
              action: CONVERSATION_FILE,
              section: sectionOfItem(item),
              itemId: item.id,
              itemActions: [
                {
                  type: 'update',
                  itemId: item.id,
                  changes: { filing: { projectId: project.id, filedBy: 'ares' } },
                },
              ],
            },
          }),
        );
      }
      return actionFindings(title, acted, skipped);
    },
  };
}
