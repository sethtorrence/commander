// Manage Todos (#196): the User tells Ares to add a Todo, tick Todos done (or open again), or move
// when they are due, from a Conversation. Each change is a proposal through the gate (act.ts).
//
// - Add: a new Todo, Ares's (its title is a model's words), due on the day the User's words mean on
//   their own calendar ("friday", "next-week"), filed under the Project they named, and made from an
//   Item he was handed when they say so (a made-from Link). Organise, in the Todos Section. A Todo made
//   from an Item is suggested on that Item, as Suggest Todos does; one made from nothing on today's
//   Daily Note, which the gate needs an Item to keep it on (made from the template if it isn't yet).
// - Done and open again: Organise for Commander's own Todos and GitHub Todos (ticking one only
//   completes it in Commander). A Linear Todo's tick moves its issue in Linear, which other people
//   see, so it is a Linear action (Act for you): it only ever asks.
// - Due: Commander's own Todos only; a Linear or GitHub Todo is due when its issue says.
import {
  CONVERSATION_LINEAR,
  CONVERSATION_TODOS,
  dueDayFrom,
  type Item,
  type ItemStatus,
  localDay,
  MANAGE_TODOS_NEEDS,
  MANAGE_TODOS_SKILL,
  type ManageTodosInput,
  manageTodosInput,
  type RegisteredAction,
  type Skill,
} from '@commander/domain';
import { type Acted, type ActionSkillOptions, acting, actionFindings, registerActions } from './act';
import { projectNamed } from './find';
import type { Findings } from './findings';

export const MANAGE_TODOS_ACTION: RegisteredAction = {
  action: CONVERSATION_TODOS,
  actionKind: 'organise',
  name: 'Manage Todos',
  hint: 'Todos Ares adds, ticks or moves when you tell him to in a Conversation',
};

// Linear actions (linear-actions.ts) registers it too: ticking a Linear Todo is one.
export const LINEAR_ACTIONS_ACTION: RegisteredAction = {
  action: CONVERSATION_LINEAR,
  actionKind: 'act-for-you',
  name: 'Linear actions',
  hint: 'Linear changes and new issues you tell Ares to make in a Conversation: always asked first',
};

const todoOf = (item: Item) => (item.detail?.kind === 'todo' ? item.detail : null);

/** The day as the User reads it: "Friday 9 October". */
export function dayWords(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, date).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

export function createManageTodosSkill(options: ActionSkillOptions): Skill<ManageTodosInput, Findings> {
  const { itemStore, gate } = options;
  const now = options.now ?? Date.now;
  registerActions(gate, MANAGE_TODOS_ACTION, LINEAR_ACTIONS_ACTION);

  return {
    ...MANAGE_TODOS_SKILL,
    input: { schema: manageTodosInput, describe: MANAGE_TODOS_NEEDS },
    async run(input, context) {
      const act = acting(context ?? {}, options);
      const acted: Acted[] = [];
      const skipped: string[] = [];

      if (input.action === 'add') {
        const project = input.project
          ? projectNamed(
              itemStore.projects().filter((each) => !each.archived),
              input.project,
            )
          : null;
        if (input.project && !project) {
          return actionFindings(
            MANAGE_TODOS_SKILL.title as string,
            [],
            ['adding the Todo: none of the User’s Projects has the name or code you gave'],
          );
        }
        const from = input.from ? act.item(input.from) : null;
        const dueOn = input.due ? dueDayFrom(input.due, now()) : null;
        const anchor =
          from ??
          itemStore.ensureDailyNote(localDay(now()), { by: { kind: 'user' } }, { fromTemplate: true });
        const parts = [
          'add the Todo you asked for',
          ...(dueOn ? [`due ${dayWords(dueOn)}`] : []),
          ...(project ? [`filed under ${project.code} · ${project.name}`] : []),
          ...(from ? [`made from ${input.from}`] : []),
        ];
        acted.push(
          act.propose({
            what: parts.join(', '),
            proposal: {
              actionKind: 'organise',
              action: CONVERSATION_TODOS,
              section: 'todos',
              itemId: anchor.id,
              itemActions: [
                {
                  type: 'create',
                  item: {
                    kind: 'todo',
                    title: input.title,
                    filing: project ? { projectId: project.id, filedBy: 'ares' } : null,
                    detail: { kind: 'todo', origin: 'ares', dueOn, backedBy: null },
                  },
                },
                ...(from
                  ? [
                      {
                        type: 'link' as const,
                        from: { step: 0 },
                        linkType: 'made-from' as const,
                        to: from.id,
                      },
                    ]
                  : []),
              ],
            },
          }),
        );
        return actionFindings(MANAGE_TODOS_SKILL.title as string, acted, skipped);
      }

      for (const ref of new Set(input.todos)) {
        const item = act.item(ref);
        const todo = todoOf(item);
        if (!todo) {
          skipped.push(`${ref} isn’t a Todo`);
          continue;
        }
        const backing = todo.backedBy ? itemStore.get(todo.backedBy)?.item : undefined;
        const linear = backing?.kind === 'linear-issue';
        if (input.action === 'due') {
          if (backing) {
            skipped.push(
              `moving ${ref}: it is a ${linear ? 'Linear' : 'GitHub'} Todo, due when its issue says`,
            );
            continue;
          }
          const dueOn = input.due === null ? null : dueDayFrom(input.due, now());
          if (dueOn === todo.dueOn) {
            skipped.push(`${ref} is already ${dueOn ? `due ${dayWords(dueOn)}` : 'without a due day'}`);
            continue;
          }
          acted.push(
            act.propose({
              what: dueOn ? `move ${ref} to ${dayWords(dueOn)}` : `take ${ref}’s due day away`,
              proposal: {
                actionKind: 'organise',
                action: CONVERSATION_TODOS,
                section: 'todos',
                itemId: item.id,
                itemActions: [{ type: 'update', itemId: item.id, changes: { detail: { ...todo, dueOn } } }],
              },
            }),
          );
          continue;
        }
        const status: ItemStatus = input.action === 'done' ? 'done' : 'open';
        if (item.status === status) {
          skipped.push(`${ref} is already ${status === 'done' ? 'done' : 'open'}`);
          continue;
        }
        const tick = status === 'done' ? `tick ${ref} done` : `open ${ref} again`;
        acted.push(
          act.propose({
            what: linear ? `${tick}, which moves its Linear issue in Linear too` : tick,
            proposal: {
              actionKind: linear ? 'act-for-you' : 'organise',
              action: linear ? CONVERSATION_LINEAR : CONVERSATION_TODOS,
              section: linear ? 'linear' : 'todos',
              itemId: item.id,
              itemActions: [{ type: 'update', itemId: item.id, changes: { status } }],
            },
          }),
        );
      }
      return actionFindings(MANAGE_TODOS_SKILL.title as string, acted, skipped);
    },
  };
}
