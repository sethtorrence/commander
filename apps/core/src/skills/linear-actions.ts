// Linear actions (#196): the User tells Ares to change Linear issues or send a Todo to Linear, from a
// Conversation ("move LT-142 to In Review", "assign it to me", "send this Todo to Linear"). What
// changes in Linear is seen by other people, so every one is Act for you, in the Linear Section,
// capped at Ask: always a card the User confirms, never done by Ares himself. Accepted, it goes the
// way the User's own change would: the issue's synced field through the outgoing queue (ADR 0003), or
// Send to Linear's new issue, made at once and queued for Linear.
//
// - An issue is a Linear issue he was handed, or the issue behind a Linear Todo.
// - A state is one of the issue's team's workflow states, by its name, as Linear sync last fetched
//   them; an assignee is the User ("me": who they are in that Linear Account), a member of the team
//   by name, or nobody.
// - Sending takes the Todo's (or Daily Note line's) words as the title and starts where the Send to
//   Linear dialog would: the team the User named, else the one for the Todo's Project (a Rule's) or
//   the last one sent to, else the only team there is; the team's default state; the User assigned.
import {
  CONVERSATION_LINEAR,
  defaultStateOf,
  type Item,
  LINEAR_NEEDS,
  LINEAR_SKILL,
  type LinearActionsInput,
  type LinearCatalogTeam,
  type LinearUser,
  linearActionsInput,
  type Skill,
} from '@commander/domain';
import { type Acted, type ActionSkillOptions, acting, actionFindings, registerActions } from './act';
import type { Findings } from './findings';
import { LINEAR_ACTIONS_ACTION } from './manage-todos';

export type LinearActionsOptions = ActionSkillOptions & {
  // Who the User is in each Linear Account (their Linear user's id), when known.
  me?: (account: string) => string | null;
  // The User's Linear Accounts.
  linearAccounts?: () => string[];
};

type Issue = Item & { detail: Extract<Item['detail'], { kind: 'linear-issue' }> };

const words = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A member the User named: by their name or display name, whole or by the start of each word. */
export function memberNamed(members: readonly LinearUser[], name: string): LinearUser | null {
  const typed = words(name);
  if (!typed.length) return null;
  return (
    members.find((member) => same(member.name, name) || same(member.displayName, name)) ??
    members.find((member) => {
      const named = [...words(member.name), ...words(member.displayName)];
      return typed.every((word) => named.some((each) => each.startsWith(word)));
    }) ??
    null
  );
}

/** A team the User named, by its key ("ENG") or name. */
const teamNamed = (teams: readonly LinearCatalogTeam[], name: string) =>
  teams.find((team) => same(team.key, name)) ?? teams.find((team) => same(team.name, name)) ?? null;

export function createLinearActionsSkill(options: LinearActionsOptions): Skill<LinearActionsInput, Findings> {
  const { itemStore, gate } = options;
  registerActions(gate, LINEAR_ACTIONS_ACTION);
  const title = LINEAR_SKILL.title as string;
  const teamOf = (issue: Issue) =>
    (issue.account ? itemStore.syncState.catalog(issue.account) : null)?.teams.find(
      (team) => team.id === issue.detail.team.id,
    ) ?? null;
  // The User as a member of a team (or as Linear knows them in the Account).
  const meIn = (account: string, team: LinearCatalogTeam | null): LinearUser | null => {
    const id = options.me?.(account) ?? null;
    if (!id) return null;
    return team?.members.find((member) => member.id === id) ?? null;
  };

  return {
    ...LINEAR_SKILL,
    input: { schema: linearActionsInput, describe: LINEAR_NEEDS },
    async run(input, context) {
      const act = acting(context ?? {}, options);
      const acted: Acted[] = [];
      const skipped: string[] = [];
      const propose = (
        what: string,
        item: Item,
        itemActions: Parameters<typeof act.propose>[0]['proposal']['itemActions'],
      ) =>
        acted.push(
          act.propose({
            what,
            proposal: {
              actionKind: 'act-for-you',
              action: CONVERSATION_LINEAR,
              section: 'linear',
              itemId: item.id,
              itemActions,
            },
          }),
        );

      if (input.action === 'send') {
        const item = act.item(input.todo);
        const todo = item.detail?.kind === 'todo' ? item.detail : null;
        if (item.kind !== 'block' && !todo) {
          return actionFindings(title, [], [`sending ${input.todo}: it isn’t a Todo or a Daily Note line`]);
        }
        if (todo?.backedBy) {
          return actionFindings(title, [], [`sending ${input.todo}: it is already backed by an issue`]);
        }
        const prefill = itemStore.linearSendPrefill({ from: item.id });
        const accounts = options.linearAccounts?.() ?? [];
        const teams = accounts.flatMap((account) =>
          (itemStore.syncState.catalog(account)?.teams ?? []).map((team) => ({ account, team })),
        );
        const chosen = input.team
          ? (() => {
              const named = teamNamed(
                teams.map((each) => each.team),
                input.team,
              );
              return teams.find((each) => each.team === named) ?? null;
            })()
          : prefill.team
            ? (teams.find(
                (each) => each.account === prefill.team?.account && each.team.id === prefill.team.teamId,
              ) ?? null)
            : teams.length === 1
              ? (teams[0] ?? null)
              : null;
        if (!chosen) {
          return actionFindings(
            title,
            [],
            [
              input.team
                ? `sending ${input.todo}: none of the User’s Linear teams has the key or name you gave`
                : teams.length
                  ? `sending ${input.todo}: it needs a Linear team, so ask the User which one`
                  : `sending ${input.todo}: Linear isn’t connected, or hasn’t synced its teams yet`,
            ],
          );
        }
        const { account, team } = chosen;
        const state = defaultStateOf(team);
        if (!state)
          return actionFindings(title, [], [`sending ${input.todo}: its team has no workflow states yet`]);
        const assignee = meIn(account, team);
        propose(
          `send ${input.todo} to Linear as a new issue${assignee ? ' assigned to the User' : ''}`,
          item,
          [
            {
              type: 'send-to-linear',
              draft: {
                from: item.id,
                account,
                team: { id: team.id, key: team.key, name: team.name },
                title: prefill.title.trim() || item.title,
                assignee,
                state,
                priority: 0,
              },
            },
          ],
        );
        return actionFindings(title, acted, skipped);
      }

      for (const ref of new Set(input.issues)) {
        const handed = act.item(ref);
        const backedBy = handed.detail?.kind === 'todo' ? handed.detail.backedBy : null;
        const found = backedBy ? itemStore.get(backedBy)?.item : handed;
        if (!found || found.deletedAt !== null || found.detail?.kind !== 'linear-issue' || !found.account) {
          skipped.push(`${ref} isn’t a Linear issue`);
          continue;
        }
        const issue = found as Issue;
        const team = teamOf(issue);
        if (input.action === 'state') {
          const wanted = input.state;
          const state =
            team?.states.find((each) => same(each.name, wanted)) ??
            team?.states.find((each) => words(each.name).join(' ').startsWith(words(wanted).join(' ')));
          if (!state) {
            skipped.push(`moving ${ref}: its team has no workflow state by the name you gave`);
            continue;
          }
          if (state.id === issue.detail.state.id) {
            skipped.push(`${ref} is already in that state`);
            continue;
          }
          propose(`move ${ref} to the state you asked for, in Linear`, issue, [
            { type: 'edit-fields', itemId: issue.id, fields: { state } },
          ]);
          continue;
        }
        // Assigning.
        let assignee: LinearUser | null = null;
        if (input.to !== null && same(input.to, 'me')) {
          assignee = meIn(issue.account as string, team);
          if (!assignee) {
            skipped.push(
              `assigning ${ref}: Commander doesn’t know who the User is in that Linear workspace yet`,
            );
            continue;
          }
        } else if (input.to !== null) {
          assignee = memberNamed(team?.members ?? [], input.to);
          if (!assignee) {
            skipped.push(`assigning ${ref}: nobody in its team has the name you gave`);
            continue;
          }
        }
        if ((assignee?.id ?? null) === (issue.detail.assignee?.id ?? null)) {
          skipped.push(`${ref} is already assigned that way`);
          continue;
        }
        const whom = assignee
          ? assignee.id === options.me?.(issue.account as string)
            ? 'the User'
            : 'the person you named'
          : 'nobody';
        propose(`assign ${ref} to ${whom}, in Linear`, issue, [
          { type: 'edit-fields', itemId: issue.id, fields: { assignee } },
        ]);
      }
      return actionFindings(title, acted, skipped);
    },
  };
}
