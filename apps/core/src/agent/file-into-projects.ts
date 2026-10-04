// "File into Projects" (#71, #108): Ares files what the Rules miss. A Linear issue from a team no
// Rule covers, or a Teams Chat no Rule names, arrives already wearing the right Badge or, when he
// isn't sure, the dashed one with Confirm and Change. A Quick job at low thinking: no tools, a reply
// that must fit OUTPUT.
//
// - Runs when Items arrive from a Source (and on the idle catch-up, or a request). It looks only at
//   live, open Linear issues and Chats that are Unfiled, that no Rule matches (Rules always win over
//   him), and that have no suggestion of his waiting; an Item the User or a Rule filed is never his
//   to file, and one he filed stays as he filed it. Muted Chats are filed like any other (muting is
//   about attention, not where a Chat belongs); an excluded Chat is deleted, so never looked at.
//   Items whose Section has Organise Off are left out before any call. At most MAX_ITEMS a run; the
//   rest wait for the next.
// - Each Item gets a call of its own, in a data block of its own (ADR 0004): with one outside Item
//   in a prompt, filing it acts on that Item alone, so it can follow the Autonomy settings. Several
//   in one call would make every filing chained (any of them may have steered him), so always Ask.
//   With it go the active Projects (name and code) and the Rules, as the User's own material.
//   - A Linear issue is described by its title, People, Source fields (workspace, team, Linear
//     project, labels) and a trimmed slice of its content.
//   - A Chat by its name and type, the people in it (with the Projects the User or a Rule filed
//     their other Chats under: where People appear is what links them to Projects), and its last
//     few messages, each trimmed: all untrusted Teams text, inside the Chat's own block.
//   - A calendar event (#127) by its title, calendar, organiser, attendees (people, not rooms) and a
//     trimmed slice of its description, inside the event's own block.
//   - All with their linked Items' Projects (codes only, never their words).
// - The reply names the Item by the reference its block was given and a Project by its code (or
//   "unfiled"), with a confidence; codes are checked against the active Projects here, and anything
//   else is dropped. Each filing is a proposal (Organise / "File into Projects", in the Item's own
//   Section) to the gate, which files it as Ares ("filed under TL by Ares", his reason in the
//   activity log) or keeps it as a suggestion: the dashed Badge.
// - The runner remembers each Item with a fingerprint of what he judged it by, so one he left
//   Unfiled, or whose suggestion was dismissed, isn't sent again until that changes: an issue's
//   title and Source fields; a Chat's name, type and people, and whether it has grown past a few
//   messages and then a full window of them (not every new message, so a busy Chat costs a few
//   calls, not one per message); an event's title, calendar and organiser.
// - Calendar events (#127): live events from yesterday to EVENT_DAYS_AHEAD days ahead, Unfiled, that
//   no Rule matches, the User hasn't declined and Commander didn't put in the calendar itself. A
//   recurring series is asked about once, by its next instance (each instance is its own Item): its
//   other instances follow that one's filing (series-filing.ts). Filed in the Calendar Section.
import {
  type AutonomySection,
  type ChatDetail,
  chatPeople,
  decide,
  describeRule,
  type EventDetail,
  type EventPerson,
  FILE_INTO_PROJECTS,
  firstMatch,
  type Item,
  type LinearIssueDetail,
  type Project,
  teamsUserOf,
} from '@commander/domain';
import { z } from 'zod';
import type { ItemStore } from '../item-store';
import type { PromptData } from './prompt';
import type { AgentJob, JobInput } from './runner';
import { bySeries, seriesFiling, seriesKey } from './series-filing';

// At most this many Items a run, one call each; the rest wait for the next trigger.
export const MAX_ITEMS = 20;
const MAX_DESCRIPTION = 600;
const MAX_COMMENT = 200;
const COMMENTS = 2;
const MAX_REASON_WORDS = 14;
const MAX_REASON_CHARS = 140;
// A Chat's latest messages that go in, each cut to MAX_MESSAGE.
export const CHAT_MESSAGES = 10;
const MAX_MESSAGE = 240;
// The kinds of Item Ares files.
const KINDS = ['linear-issue', 'chat'] as const;
const CHAT_TYPES: Record<ChatDetail['chatType'], string> = {
  'one-on-one': 'one-to-one chat',
  group: 'group chat',
  meeting: 'meeting chat',
};
// The events Ares looks at: from a day ago to this many days ahead.
export const EVENT_DAYS_AHEAD = 30;
const DAY_MS = 24 * 60 * 60_000;
const MAX_ATTENDEES = 10;

export const OUTPUT = z.object({
  filings: z
    .array(
      z.object({
        // The reference the Item's block was given (I1), never its id.
        itemId: z.string().min(1).max(20),
        // A Project's code, or "unfiled".
        projectCode: z.string().trim().min(1).max(20),
        confidence: z.number().min(0).max(1),
        reason: z.string().max(600).optional(),
      }),
    )
    .max(20),
});
type Output = z.infer<typeof OUTPUT>;

type Candidate = { ref: string; item: Item; fingerprint: string };
type Input = JobInput & { candidates: Candidate[] };

const INSTRUCTIONS = `You are Ares. You file the User's incoming Items into their Projects: the bodies of work they are pursuing.

The data holds the User's Projects (each with its two-letter code and name, and the Rules that already file Items into it), then the Item to file, labelled with its reference (I1) and what it is, with its facts:
- a Linear issue: title, people, where it comes from in its Source (workspace, team, Linear project, labels), and some of its content;
- a Teams Chat: its name and type, the people in it (with where the User filed other Chats with them), and its latest messages;
- a calendar event: its title, the calendar it is on, its organiser and attendees, and some of its description;
and the Projects of Items linked to it.

Decide which one Project the Item belongs to, judging by its team, Linear project, labels, calendar, people (and the Projects they work on), subject and content, and its linked Items' Projects, the way the User's Rules file similar Items. If none fits, or you can't tell, say "unfiled".

Reply with only this JSON object: {"filings":[{"itemId":"I1","projectCode":"TL","confidence":0.9,"reason":"…"}]}
- itemId: the Item's reference, exactly as labelled.
- projectCode: one of the Projects' codes exactly as listed, or "unfiled".
- confidence: how sure you are, from 0 to 1. 0.9 or more only when the Item plainly belongs there (its team, Linear project or people belong to that Project alone); 0.5 to 0.8 when it is likely; below 0.5 when it is a guess.
- reason: why, in a few plain words of your own (fewer than 12), as you would say it to the User: "Relay is a Titanlink project". No full stop.`;

const cut = (text: string, length: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > length ? `${one.slice(0, length - 1).trimEnd()}…` : one;
};

// "A, B, and C"; "A and B"; "A".
function listed(words: readonly string[]): string {
  if (words.length < 2) return words.join('');
  const last = words.at(-1);
  return `${words.slice(0, -1).join(', ')}${words.length > 2 ? ',' : ''} and ${last}`;
}

// A reason as the activity log keeps it: one line, a few words, no closing full stop.
function cleanReason(reason: string | undefined): string | null {
  const words = (reason ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。]+$/, '')
    .split(' ')
    .filter(Boolean);
  if (!words.length) return null;
  const text =
    words.length > MAX_REASON_WORDS ? `${words.slice(0, MAX_REASON_WORDS - 2).join(' ')}…` : words.join(' ');
  return cut(text, MAX_REASON_CHARS);
}

const issueOf = (item: Item): LinearIssueDetail | null =>
  item.detail?.kind === 'linear-issue' ? item.detail : null;

const chatOf = (item: Item): ChatDetail | null =>
  item.source === 'teams' && item.detail?.kind === 'chat' ? item.detail : null;

const eventOf = (item: Item): EventDetail | null => (item.detail?.kind === 'event' ? item.detail : null);

// "Dana Ruiz (dana@titanlink.test)", "you (alex@gmail.test)".
const personText = (person: EventPerson) =>
  `${person.self ? 'you' : person.name?.trim() || person.email} (${person.email})`;

// The Autonomy Section an Item is filed in.
const sectionOf = (item: Item): AutonomySection =>
  chatOf(item) ? 'teams' : eventOf(item) ? 'calendar' : 'linear';

// A Chat's messages that say something: no system events, nothing deleted.
const spoken = (chat: ChatDetail) => chat.messages.filter((message) => message.from && !message.deleted);

// How far a Chat has grown, as far as filing it goes: no messages, a few, or a full window.
function chatGrowth(chat: ChatDetail): number {
  const count = spoken(chat).length;
  if (count >= CHAT_MESSAGES) return 3;
  if (count >= 3) return 2;
  return count >= 1 ? 1 : 0;
}

// What Ares judges an Item by: when none of it changes, he has nothing new to go on.
export function filingFingerprint(item: Item): string {
  const title = item.title.trim().replace(/\s+/g, ' ').toLowerCase();
  const chat = chatOf(item);
  if (chat) {
    const people = chatPeople(item).map((person) => person.value);
    return JSON.stringify([title, item.account, chat.chatType, people.sort(), chatGrowth(chat)]);
  }
  const event = eventOf(item);
  if (event) {
    return JSON.stringify([
      title,
      item.account,
      event.calendar.id,
      event.organiser?.email.toLowerCase() ?? null,
    ]);
  }
  const issue = issueOf(item);
  return JSON.stringify([
    title,
    item.account,
    issue?.team.id ?? null,
    issue?.linearProject?.id ?? null,
    [...(issue?.labels.map((label) => label.id) ?? [])].sort(),
  ]);
}

const pendingFilings = (itemStore: ItemStore) =>
  itemStore.autonomy.proposals({ action: FILE_INTO_PROJECTS, statuses: ['pending'], limit: 1000 });

/**
 * Ares's filing suggestions that are no longer his to make: their Item has since been filed by the
 * User or by a Rule (a Rule always wins over his judgement). The Agent dismisses them.
 */
export function staleFilingSuggestions(itemStore: ItemStore): number[] {
  return pendingFilings(itemStore)
    .filter((proposal) => {
      const filedBy = itemStore.get(proposal.itemId)?.item.filing?.filedBy;
      return filedBy === 'user' || filedBy === 'rule';
    })
    .map((proposal) => proposal.id);
}

export function fileIntoProjectsJob(
  itemStore: ItemStore,
  { maxItems = MAX_ITEMS, now = Date.now }: { maxItems?: number; now?: () => number } = {},
): AgentJob<Input, Output> {
  const waiting = () => new Set(pendingFilings(itemStore).map((proposal) => proposal.itemId));

  // The days of events Ares looks at: from a day ago to EVENT_DAYS_AHEAD days ahead.
  const eventWindow = () => {
    const at = now();
    return { from: at - DAY_MS, to: at + EVENT_DAYS_AHEAD * DAY_MS };
  };
  // An event Ares may look at (besides being Unfiled and unmatched): in the window, not declined, and
  // not one Commander put in the calendar itself.
  function eventInScope(item: Item): boolean {
    const event = eventOf(item);
    if (!event) return false;
    const { from, to } = eventWindow();
    return (
      event.end.at > from &&
      event.start.at < to &&
      event.myResponse !== 'declined' &&
      event.createdByCommander === null
    );
  }

  // Whether the User's Autonomy settings have filing Off in the Item's Section.
  const off = (item: Item) =>
    decide(
      {
        action: FILE_INTO_PROJECTS,
        actionKind: 'organise',
        section: sectionOf(item),
        confidence: 1,
        chained: false,
      },
      itemStore.autonomy.settings(),
    ) === 'off';

  // An Item Ares may file: a live, open Linear issue, Teams Chat or calendar event in scope, Unfiled,
  // that no Rule matches and that has no suggestion of his waiting.
  function candidate(item: Item | undefined, rules = itemStore.rules(), pending = waiting()): item is Item {
    return (
      !!item &&
      (item.kind === 'linear-issue' || !!chatOf(item) || eventInScope(item)) &&
      item.deletedAt === null &&
      item.status === 'open' &&
      item.filing === null &&
      !pending.has(item.id) &&
      !firstMatch(rules, item)
    );
  }

  const codeOf = (projectId: string | undefined) =>
    projectId ? (itemStore.projectRef(projectId)?.code ?? null) : null;

  // The Projects of the Items linked to this one, by code and kind: never their words, which would
  // put another outside Item's text in this one's block.
  function linkedProjects(item: Item): string[] {
    const view = itemStore.get(item.id);
    if (!view) return [];
    const found = new Set<string>();
    for (const link of [...view.links, ...view.backlinks]) {
      const other = link.from.id === item.id ? link.to : link.from;
      if (other.kind === 'project') {
        found.add(`${other.code} (the Project itself)`);
        continue;
      }
      const code = codeOf(itemStore.get(other.id)?.item.filing?.projectId);
      if (code) found.add(`${code} (a ${other.kind === 'linear-issue' ? 'Linear issue' : other.kind})`);
    }
    return [...found];
  }

  // Where the User (or a Rule) filed other Chats with each of these people: what links People to
  // Projects until Memory keeps such facts. Ares's own filings don't count, so he never learns from
  // himself. Codes and counts only, never another Chat's words.
  function peoplesProjects(item: Item): string[] {
    const people = chatPeople(item);
    if (!people.length) return [];
    const byPerson = new Map(people.map((person) => [person.value, new Map<string, number>()]));
    for (const other of itemStore.query({ kinds: ['chat'], source: 'teams', limit: 1000 })) {
      const filedBy = other.filing?.filedBy;
      if (other.id === item.id || (filedBy !== 'user' && filedBy !== 'rule')) continue;
      const code = codeOf(other.filing?.projectId);
      if (!code) continue;
      for (const { value } of chatPeople(other)) {
        const counts = byPerson.get(value);
        counts?.set(code, (counts.get(code) ?? 0) + 1);
      }
    }
    return people.flatMap((person) => {
      const counts = [...(byPerson.get(person.value) ?? [])].sort((a, b) => b[1] - a[1]);
      return counts.length
        ? [`${person.label}: ${counts.map(([code, n]) => `${code} (${n})`).join(', ')}`]
        : [];
    });
  }

  function chatFacts(item: Item, chat: ChatDetail): string {
    const me = teamsUserOf(item.account);
    const isMe = (userId: string | null | undefined) => me !== null && userId === me;
    const people = chat.members
      .filter((member) => !isMe(member.userId))
      .map((member) => (member.email ? `${member.name} (${member.email})` : member.name));
    if (chat.members.some((member) => isMe(member.userId))) people.push('the User');
    const known = peoplesProjects(item);
    const messages = spoken(chat)
      .slice(-CHAT_MESSAGES)
      .map(
        (message) =>
          `${isMe(message.from?.userId) ? 'the User' : (message.from?.name ?? 'someone')}: ${cut(message.text, MAX_MESSAGE)}`,
      );
    const linked = linkedProjects(item);
    return [
      `Chat name: ${item.title}`,
      `Chat type: ${CHAT_TYPES[chat.chatType]}`,
      ...(people.length ? [`People: ${listed(people)}`] : []),
      ...(known.length ? [`Where its people’s other Chats are filed: ${known.join('; ')}`] : []),
      ...(messages.length ? ['Latest messages (oldest first):', ...messages] : ['No messages yet']),
      ...(linked.length ? [`Linked Items’ Projects: ${linked.join(', ')}`] : []),
    ].join('\n');
  }

  function eventFacts(item: Item, event: EventDetail): string {
    const people = event.attendees.filter((attendee) => !attendee.resource);
    const shown = people.slice(0, MAX_ATTENDEES).map(personText);
    const more = people.length - shown.length;
    const linked = linkedProjects(item);
    return [
      `Title: ${item.title}`,
      `Calendar: ${event.calendar.name}`,
      ...(event.accountEmail && event.accountEmail !== event.calendar.name
        ? [`Account: ${event.accountEmail}`]
        : []),
      ...(event.organiser ? [`Organiser: ${personText(event.organiser)}`] : []),
      ...(shown.length ? [`Attendees: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`] : []),
      ...(event.description?.trim() ? [`Description: ${cut(event.description, MAX_DESCRIPTION)}`] : []),
      ...(linked.length ? [`Linked Items' Projects: ${linked.join(', ')}`] : []),
    ].join('\n');
  }

  function factsOf(item: Item): string {
    const chat = chatOf(item);
    if (chat) return chatFacts(item, chat);
    const event = eventOf(item);
    if (event) return eventFacts(item, event);
    const issue = issueOf(item);
    if (!issue) return `Title: ${item.title}`;
    const people = [
      ...(issue.assignee ? [`${issue.assignee.name} (assignee)`] : []),
      ...(issue.creator ? [`${issue.creator.name} (creator)`] : []),
    ];
    const comments = issue.comments.slice(-COMMENTS);
    const linked = linkedProjects(item);
    return [
      `Title: ${item.title}`,
      ...(people.length ? [`People: ${people.join(', ')}`] : []),
      ...(item.account ? [`Workspace: ${item.account}`] : []),
      `Team: ${issue.team.key} (${issue.team.name})`,
      ...(issue.linearProject ? [`Linear project: ${issue.linearProject.name}`] : []),
      ...(issue.labels.length ? [`Labels: ${issue.labels.map((label) => label.name).join(', ')}`] : []),
      ...(issue.description ? [`Description: ${cut(issue.description, MAX_DESCRIPTION)}`] : []),
      ...comments.map(
        (comment) => `Comment (${comment.author?.name ?? 'someone'}): ${cut(comment.body, MAX_COMMENT)}`,
      ),
      ...(linked.length ? [`Linked Items' Projects: ${linked.join(', ')}`] : []),
    ].join('\n');
  }

  function projectsText(projects: readonly Project[]): string {
    const rules = itemStore.rules();
    if (!projects.length) return 'The User has no Projects yet.';
    return projects
      .map((project) => {
        const own = rules.filter(
          (rule) => rule.target.kind === 'project' && rule.target.projectId === project.id,
        );
        return [
          `${project.code} · ${project.name}`,
          ...own.map((rule) => `  Rule: ${describeRule(rule.when)}`),
        ].join('\n');
      })
      .join('\n');
  }

  return {
    job: FILE_INTO_PROJECTS,
    name: 'File into Projects',
    tier: 'quick',
    reasoningEffort: 'low',
    // Each filing follows its own Item's Section (Linear, Teams or Calendar): see `sectionOf`.
    action: {
      action: FILE_INTO_PROJECTS,
      actionKind: 'organise',
      section: null,
      hint: 'Linear issues, Teams Chats and calendar events no Rule files, into the Project they belong to',
    },
    triggers: { 'items-arrived': true, idle: true },

    gather({ triggers, seen }) {
      const rules = itemStore.rules();
      const pending = waiting();
      // The Items that just arrived first, then the newest of the rest.
      const arrived = new Set(triggers.flatMap((trigger) => ('itemIds' in trigger ? trigger.itemIds : [])));
      const issuesAndChats = itemStore.query({
        kinds: [...KINDS],
        projectId: null,
        statuses: ['open'],
        limit: 1000,
      });
      // Events in the window, Unfiled. A recurring series is asked about once, by its next instance:
      // not at all once it is filed (the other instances follow, series-filing.ts) or has a
      // suggestion waiting, nor when Ares has already looked at one of its instances as it is now.
      const inWindow = itemStore.events({ ...eventWindow(), limit: 1000 });
      const groups = bySeries(inWindow);
      const asked = new Set<string>();
      const events = inWindow
        .filter((item) => item.filing === null && eventInScope(item))
        .filter((item) => {
          const key = seriesKey(item);
          if (!key) return true;
          const instances = groups.get(key) ?? [];
          if (asked.has(key) || seriesFiling(instances) !== null) return false;
          if (instances.some((each) => seen(each.id, filingFingerprint(each)))) return false;
          asked.add(key);
          return true;
        });
      const unfiled = [...issuesAndChats, ...events];
      const ordered = [
        ...unfiled.filter((item) => arrived.has(item.id)),
        ...unfiled.filter((item) => !arrived.has(item.id)),
      ];
      const candidates: Candidate[] = [];
      for (const item of ordered) {
        if (candidates.length >= maxItems) break;
        const fingerprint = filingFingerprint(item);
        if (!candidate(item, rules, pending) || off(item) || seen(item.id, fingerprint)) continue;
        candidates.push({ ref: 'I1', item, fingerprint });
      }
      // A series' other Unfiled instances are remembered with the one asked about, so his answer
      // stands for the series and none of them is sent again until it changes.
      const siblings = candidates.flatMap(({ item }) => {
        const key = seriesKey(item);
        return (key ? (groups.get(key) ?? []) : [])
          .filter((each) => each.id !== item.id && each.filing === null)
          .map((each) => ({ itemId: each.id, fingerprint: filingFingerprint(each) }));
      });
      return {
        items: [
          ...candidates.map(({ item, fingerprint }) => ({ itemId: item.id, fingerprint })),
          ...siblings,
        ],
        candidates,
      };
    },

    // One Item per call: see the top of this file.
    batch: (input) =>
      input.candidates.map((one) => ({
        items: [{ itemId: one.item.id, fingerprint: one.fingerprint }],
        candidates: [one],
      })),

    prompt(input) {
      const data: PromptData[] = [
        { label: 'Projects', from: 'user-settings', text: projectsText(itemStore.projects()) },
        ...input.candidates.map(({ ref, item }) => ({
          label: chatOf(item)
            ? `${ref} · Teams Chat`
            : eventOf(item)
              ? `${ref} · Calendar event`
              : `${ref} · Linear issue ${issueOf(item)?.identifier ?? ''}`.trim(),
          from: item,
          text: factsOf(item),
        })),
      ];
      return { instructions: INSTRUCTIONS, data };
    },

    output: OUTPUT,

    proposals(output, input) {
      const byRef = new Map(input.candidates.map((one) => [one.ref, one]));
      const byCode = new Map(itemStore.projects().map((project) => [project.code.toUpperCase(), project]));
      const used = new Set<string>();
      const dropped: string[] = [];
      const proposals = output.filings.flatMap((filing) => {
        const offered = byRef.get(filing.itemId.trim());
        if (!offered) {
          dropped.push(`it named ${filing.itemId}, which it wasn’t given`);
          return [];
        }
        if (used.has(offered.ref)) {
          dropped.push(`it named ${offered.ref} twice`);
          return [];
        }
        used.add(offered.ref);
        const code = filing.projectCode.trim().toUpperCase();
        if (code === 'UNFILED') return [];
        const project = byCode.get(code);
        if (!project) {
          dropped.push(`it chose ${filing.projectCode}, which is no active Project's code`);
          return [];
        }
        // The Item may have been filed (or changed) while Ares was thinking.
        const item = itemStore.get(offered.item.id)?.item;
        if (!candidate(item) || filingFingerprint(item) !== offered.fingerprint) {
          dropped.push(`${offered.ref} changed while Ares was looking at it`);
          return [];
        }
        return [
          {
            itemId: item.id,
            section: sectionOf(item),
            itemActions: [
              {
                type: 'update' as const,
                itemId: item.id,
                changes: { filing: { projectId: project.id, filedBy: 'ares' as const } },
              },
            ],
            confidence: filing.confidence,
            reason: cleanReason(filing.reason) ?? `Looks like ${project.name} work`,
          },
        ];
      });
      return { proposals, dropped };
    },
  };
}
