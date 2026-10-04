import {
  type ActivityEntry,
  defaultStateOf,
  type Filing,
  type ItemAction,
  type LinearCatalog,
  type LinearCatalogTeam,
  type LinearIssueDraft,
  type LinearSendPrefill,
  type LinearUser,
} from '@commander/domain';
import type { AccountSummary } from '@commander/domain/ipc';
import type { ItemStoreClient } from '../../item-store/client';

/*
  Send to Linear, as the window sees it: a new Linear issue from a Todo (the Todos Section), a Block
  (its margin menu in Notes) or nothing (New Linear issue, in the Linear Section). The dialog starts
  from the Core's prefill (the title, and the team from the item's Project's Rules or the team last
  sent to), offers each connected workspace's teams, members and states as its last sync fetched them,
  and sends one draft. The Core makes the issue at once and queues it for Linear; the send's entries
  come back so undoing them, last first, undoes it (deleting the issue in Linear).
*/

/** What is being sent: a Todo or Block (`from`), or a new issue in the Project filter's Project. */
export interface SendTarget {
  from?: string;
  /** For a new issue made from nothing: where it is filed (the Project filter's), and its Project for the team. */
  filing?: Filing;
}

export interface LinearSender {
  prefill(target: SendTarget): Promise<LinearSendPrefill>;
  /** What an Account's Linear offers (teams, their states and members), as its last sync fetched it. */
  catalog(account: string): Promise<LinearCatalog | null>;
  /** Sends the issue; its entries come back, the issue's creation first. */
  send(draft: LinearIssueDraft): Promise<ActivityEntry[]>;
  /** Undoes a send, given its entries' ids. */
  undo(entryIds: readonly number[]): Promise<void>;
}

export function linearSenderIn(itemStore: ItemStoreClient): LinearSender {
  return {
    prefill(target) {
      return itemStore({
        op: 'linear-send-prefill',
        ...(target.from ? { from: target.from } : { projectId: target.filing?.projectId ?? null }),
      });
    },
    catalog(account) {
      return itemStore({ op: 'source-catalog', account });
    },
    send(draft) {
      return itemStore({ op: 'send-to-linear', draft });
    },
    async undo(entryIds) {
      if (!entryIds.length) return;
      const actions = [...entryIds].reverse().map((entryId): ItemAction => ({ type: 'undo', entryId }));
      await itemStore({ op: 'record-all', actions, why: 'Undid Send to Linear' });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The dialog's form

/** The dialog's choices. Ids are null until there is something to choose from. */
export interface SendForm {
  title: string;
  account: string | null;
  teamId: string | null;
  /** The assignee's Linear user id, or null for unassigned. */
  assigneeId: string | null;
  stateId: string | null;
  priority: number;
  description: string;
}

export type Catalogs = ReadonlyMap<string, LinearCatalog | null>;

const teamOf = (catalogs: Catalogs, account: string | null, teamId: string | null) =>
  (account && catalogs.get(account)?.teams.find((team) => team.id === teamId)) || null;

/** The User in an Account, as a Linear user (their name as Commander knows it). */
function meIn(account: AccountSummary | undefined): LinearUser | null {
  const user = account?.user;
  return user ? { id: user.id, name: user.name, displayName: user.name, email: null } : null;
}

/** Whom the issue can be assigned to: the User first, then the team's other members. */
export function assigneeChoices(
  accounts: readonly AccountSummary[],
  catalogs: Catalogs,
  form: Pick<SendForm, 'account' | 'teamId'>,
): LinearUser[] {
  const me = meIn(accounts.find((account) => account.id === form.account));
  const members = teamOf(catalogs, form.account, form.teamId)?.members ?? [];
  const mine = me ? (members.find((member) => member.id === me.id) ?? me) : null;
  return [...(mine ? [mine] : []), ...members.filter((member) => member.id !== mine?.id)];
}

/** The workspaces that can take a new issue: connected, with teams Commander knows. */
export function sendableAccounts(accounts: readonly AccountSummary[], catalogs: Catalogs): AccountSummary[] {
  return accounts.filter((account) => (catalogs.get(account.id)?.teams.length ?? 0) > 0);
}

/** The form for a team: its default state, and the User as assignee (they stay if they're there). */
export function withTeam(
  form: SendForm,
  account: string | null,
  teamId: string | null,
  accounts: readonly AccountSummary[],
  catalogs: Catalogs,
): SendForm {
  const team = teamOf(catalogs, account, teamId);
  const me = accounts.find((each) => each.id === account)?.user?.id ?? null;
  return {
    ...form,
    account,
    teamId: team?.id ?? null,
    stateId: team ? (defaultStateOf(team)?.id ?? null) : null,
    assigneeId: me,
  };
}

/**
 * Where the dialog starts: the prefill's title and team (in its workspace), else the first workspace's
 * first team; the team's default state; assigned to the User; no priority.
 */
export function initialForm(
  prefill: LinearSendPrefill,
  accounts: readonly AccountSummary[],
  catalogs: Catalogs,
): SendForm {
  const blank: SendForm = {
    title: prefill.title,
    account: null,
    teamId: null,
    assigneeId: null,
    stateId: null,
    priority: 0,
    description: '',
  };
  const usable = sendableAccounts(accounts, catalogs);
  const chosen =
    prefill.team && teamOf(catalogs, prefill.team.account, prefill.team.teamId) ? prefill.team : null;
  const account = chosen?.account ?? usable[0]?.id ?? null;
  const teamId = chosen?.teamId ?? (account ? (catalogs.get(account)?.teams[0]?.id ?? null) : null);
  return withTeam(blank, account, teamId, accounts, catalogs);
}

/** The team the form has chosen, if Commander knows it. */
export function chosenTeam(form: SendForm, catalogs: Catalogs): LinearCatalogTeam | null {
  return teamOf(catalogs, form.account, form.teamId);
}

/** The draft to send, or why it can't be sent yet. */
export function draftOf(
  form: SendForm,
  target: SendTarget,
  accounts: readonly AccountSummary[],
  catalogs: Catalogs,
): { draft: LinearIssueDraft } | { problem: string } {
  const title = form.title.trim();
  if (!title) return { problem: 'An issue needs a title' };
  const team = chosenTeam(form, catalogs);
  if (!form.account || !team) return { problem: 'Choose a team' };
  const state = team.states.find((each) => each.id === form.stateId) ?? defaultStateOf(team);
  if (!state) return { problem: `${team.name} has no workflow states Commander knows yet` };
  const assignee =
    form.assigneeId === null
      ? null
      : (assigneeChoices(accounts, catalogs, form).find((user) => user.id === form.assigneeId) ?? null);
  const description = form.description.trim();
  return {
    draft: {
      ...(target.from ? { from: target.from } : target.filing ? { filing: target.filing } : {}),
      account: form.account,
      team: { id: team.id, key: team.key, name: team.name },
      title,
      ...(description && { description }),
      assignee,
      state,
      priority: form.priority,
    },
  };
}
