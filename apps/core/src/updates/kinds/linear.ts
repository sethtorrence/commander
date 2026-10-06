// Update lines from Linear (#75, #186): issues taken off the User's list, stuck issues, and an Account
// to reconnect. Each names the issues (identifier, and the title when there is one), says what
// happened and whether it needs the User, from the issues' own data.
import type { Item } from '@commander/domain';
import type { LineContext, LineKind } from './types';
import { daysSince, listed, namedWhere, oneLine, sentence } from './words';

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// An issue by name and where it is, or its identifier alone when it has gone.
const issueName = (itemId: string, identifier: string, context: LineContext) => {
  const item = context.item(itemId);
  return item ? namedWhere(item) : `${identifier} in Linear`;
};

// What happened to an issue, from its activity entry's words ("ENG-418 was reassigned to Priya
// Patel"): "was reassigned to Priya Patel", or null when the words don't start with the issue.
function happened({ identifier, why }: { identifier: string; why: string }): string | null {
  const words = oneLine(why);
  if (!words.startsWith(`${identifier} `)) return null;
  return words
    .slice(identifier.length + 1)
    .replace(/ in Linear$/, '')
    .replace(/[.]$/, '');
}

export const leftLines: LineKind<'linear-left'> = {
  name: 'Linear issues taken off your list',
  template({ about }, context) {
    const [only, ...others] = about.issues;
    if (only && !others.length) {
      const name = issueName(only.itemId, only.identifier, context);
      const what = happened(only);
      return what
        ? `${name} ${what}, so it’s off your Todos. Nothing to do, unless it should still be yours.`
        : `${name} is off your Todos: ${sentence(only.why)} Nothing to do, unless it should still be yours.`;
    }
    const count = about.issues.length;
    const how = about.issues.every((issue) => issue.reassigned) ? 'were reassigned' : 'left your list';
    return `${count} of your Linear issues ${how}, so they’re off your Todos: ${listed(about.issues.map((issue) => issue.identifier))}. Nothing to do, unless one should still be yours.`;
  },
  facts: ({ about }) => [
    'What it is: Linear issues a sync took off the User’s list (reassigned, unassigned, cancelled, moved out of their Todo states, or deleted), so their Linear Todos went.',
    `How many: ${about.issues.length}`,
    ...(about.issues.every((issue) => issue.reassigned) ? ['All of them were reassigned.'] : []),
    'Nothing changed in Linear because of it; the User needs to do nothing unless one should still be theirs.',
  ],
  row({ about }, itemId) {
    const issue = about.issues.find((each) => each.itemId === itemId);
    if (!issue) return null;
    const what = happened(issue);
    return {
      state: what ? capital(what.replace(/^was /, '')) : oneLine(issue.why),
      actions: ['open', 'dismiss'],
      more: [`What happened: ${oneLine(issue.why)}`],
    };
  },
  without(about, itemId) {
    const issues = about.issues.filter((issue) => issue.itemId !== itemId);
    return issues.length ? { ...about, issues } : null;
  },
  guidance: `Linear issues taken off the User's list: say which issues (the identifier, with the title when there is only one), what happened to them, that they're off the User's Todos, and that there's nothing to do unless one should still be theirs.
Good: "ENG-418 “Throttle bursts on /sync” in Linear went to Priya Patel, so it’s off your Todos. Nothing to do unless it should still be yours."
Bad: "3 of your Linear issues were reassigned." (Which ones? Does it matter?)`,
};

// Ares's reason, as a sentence that doesn't name the issue twice: "ENG-2 has sat…" → "It has sat…".
const because = ({ identifier, reason }: { identifier: string; reason: string }) => {
  const words = oneLine(reason);
  return sentence(words.startsWith(`${identifier} `) ? `It ${words.slice(identifier.length + 1)}` : words);
};

const stateOf = (item: Item | null) =>
  item?.detail?.kind === 'linear-issue' ? item.detail.state.name : null;

export const stuckLines: LineKind<'linear-stuck'> = {
  name: 'stuck Linear issues',
  template({ about }, context) {
    const [only, ...others] = about.issues;
    if (only && !others.length) {
      return `${issueName(only.itemId, only.identifier, context)} looks stuck. ${because(only)} Open it to move it along, or tick it if it’s done.`;
    }
    const newest = Math.max(...about.issues.map((issue) => issue.changedAt));
    const team = oneLine(about.team.name);
    const whose = team ? `${team} issues in Linear` : 'Linear issues';
    return `${about.issues.length} of your ${whose} haven’t moved in at least ${daysSince(newest, context.now)}: ${listed(about.issues.map((issue) => issue.identifier))}. Each is below with why; open one to move it along, or tick it if it’s done.`;
  },
  facts: ({ about }, context) => [
    'What it is: the User’s own Linear issues that Ares judged stuck (not moving).',
    `How many: ${about.issues.length}`,
    `Unchanged for at least: ${daysSince(Math.max(...about.issues.map((issue) => issue.changedAt)), context.now)}`,
    'What the User can do: open one to move it along, or tick it if it’s done. Each issue leaves the line once it changes.',
  ],
  row({ about }, itemId, context) {
    const issue = about.issues.find((each) => each.itemId === itemId);
    if (!issue) return null;
    const state = stateOf(context.item(itemId));
    const unchanged = `unchanged for ${daysSince(issue.changedAt, context.now)}`;
    return {
      state: state ? `${state} · ${unchanged}` : capital(unchanged),
      actions: context.todoOf(itemId) ? ['open', 'tick', 'dismiss'] : ['open', 'dismiss'],
      more: [`Ares's reason: ${oneLine(issue.reason)}`, `Team: ${oneLine(about.team.name)}`],
    };
  },
  without(about, itemId) {
    const issues = about.issues.filter((issue) => issue.itemId !== itemId);
    return issues.length ? { ...about, issues } : null;
  },
  guidance: `Stuck Linear issues: name the issue (identifier, and the title when there is only one), say in a few words why it looks stuck (from the reason you were given), and what to do: open it to move it along, or tick it if it's done. For several, say how many and name them.
Good: "ENG-2 “Rate limiter” has sat in review for 5 days with nobody looking at it. Open it to nudge it along, or tick it if it’s done."
Bad: "3 of your Linear issues look stuck." (Which? Why? What should I do?)`,
};

const HOLDS: Record<string, string> = {
  Linear: 'its issues',
  Google: 'its mail and calendar',
  Outlook: 'its mail and calendar',
  Teams: 'its Chats',
  GitHub: 'its pull requests and issues',
};

export const reconnectLines: LineKind<'reconnect'> = {
  name: 'an Account that needs signing in again',
  template({ about }) {
    const which = about.name ? `${about.sourceName} (${about.name})` : `Your ${about.sourceName} Account`;
    return `${which} needs you to sign in again, so I’ve paused syncing it and ${HOLDS[about.sourceName] ?? 'what it holds'} may be out of date. Sign in again from Settings → Accounts.`;
  },
  facts: ({ about }) => [
    `Account: ${about.sourceName}${about.name ? ` (${about.name})` : ''}`,
    'What happened: its sign-in stopped working, so syncing it is paused.',
    `What may be out of date: ${HOLDS[about.sourceName] ?? 'what it holds'}`,
    'What to do: sign in again from Settings → Accounts (the line’s Open goes there). The line clears itself once it is reconnected.',
  ],
  row: () => null,
  guidance: `An Account that needs signing in again: name it, say syncing is paused and what may be out of date, and that the User can sign in again from Settings → Accounts.
Good: "Linear (Acme) needs you to sign in again, so its issues may be out of date. Sign in from Settings → Accounts."
Bad: "There’s an authentication problem with one of your integrations." (Which one? Jargon.)`,
};
