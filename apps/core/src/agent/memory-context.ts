// Memory in Ares's jobs (#74, ADR 0006): what an Item is, as Memory knows it, and the memories about
// it as prompt material.
//
// - `aboutItem`: how an example names an Item (its Source facts, the kind of thing a Rule matches:
//   a Linear issue's identifier, team, Linear project and labels; a Chat's people; an event's
//   organiser and calendar; a GitHub Item's repo, labels and author, #118; an email's sender and
//   mailing list, #141), the words it is found by (those, its title and its people), and its
//   people's handles. An example's words never carry the Item's free text, so they can go in the
//   User's own block.
// - `recall`: looks up the memories about what a job is working on and hands them over as at most
//   two data blocks: what the User confirmed (their answers, their words, facts they confirmed) as
//   their own material, and what Ares picked up from outside content but the User hasn't confirmed
//   as background, which the prompt builder marks so and the runner never lets lead to more than a
//   Suggestion. A People-to-Project fact is only ever context: the jobs' instructions say it never
//   outweighs the Item's own facts, and Rules and the User's filing never reach Ares at all.
//   Given the embedding of what the job is working on (`meaning`, #73), memories are found by meaning
//   too, so one phrased differently from the Item still reaches the prompt. What the User told Ares
//   in a Conversation (#194) is confirmed, so it comes back here as theirs, like any other.
import {
  emailSubject,
  type Item,
  identitiesOf,
  type MemoryKind,
  senderDomains,
  teamsUserOf,
} from '@commander/domain';
import type { ItemStore, QueryVector, RecalledMemory } from '../item-store';
import type { PromptData } from './prompt';

const MAX_PEOPLE = 4;
const MAX_TITLE = 60;

const cut = (text: string, length: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > length ? `${one.slice(0, length - 1).trimEnd()}…` : one;
};

// "A, B and C"; "A and B"; "A".
function listed(words: readonly string[]): string {
  if (words.length < 2) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

export type AboutItem = {
  // How an example names it: "Linear issue OPS-1 (team OPS · Relay · infra)".
  subject: string;
  // The words it is found by: its subject, title, Source fields and people.
  words: string;
  // Its people, as handles.
  handles: string[];
};

export function aboutItem(item: Item): AboutItem {
  const detail = item.detail;
  const words: string[] = [item.title];
  let subject = `“${cut(item.title, MAX_TITLE)}”`;
  if (detail?.kind === 'linear-issue') {
    const facts = [
      `team ${detail.team.key}`,
      ...(detail.linearProject ? [detail.linearProject.name] : []),
      ...detail.labels.map((label) => label.name),
    ];
    subject = `Linear issue ${detail.identifier} (${facts.join(' · ')})`;
    words.push(detail.identifier, detail.team.key, detail.team.name, ...facts);
    for (const person of [detail.assignee, detail.creator]) {
      if (person) words.push(person.name, person.email ?? '');
    }
  } else if (detail?.kind === 'chat') {
    const me = teamsUserOf(item.account);
    const others = detail.members.filter((member) => me === null || member.userId !== me);
    const names = others.map((member) => member.name).filter(Boolean);
    const shown = names.slice(0, MAX_PEOPLE);
    const more = names.length - shown.length;
    subject = names.length
      ? `The Teams Chat with ${listed(more > 0 ? [...shown, `${more} more`] : shown)}`
      : 'A Teams Chat';
    words.push(...others.flatMap((member) => [member.name, member.email ?? '']));
  } else if (detail?.kind === 'channel-post') {
    // A Channel post (#111) by where it was posted and who posted, never its text.
    subject = `The Teams post in ${detail.team.name} / ${detail.channel.name}`;
    words.push(
      detail.team.name,
      detail.channel.name,
      ...[detail.post, ...detail.replies].flatMap((message) => (message.from ? [message.from.name] : [])),
    );
  } else if (detail?.kind === 'event') {
    const organiser = detail.organiser;
    const by = organiser ? ` organised by ${organiser.name?.trim() || organiser.email}` : '';
    subject = `The event${by} on the ${detail.calendar.name} calendar`;
    const people = [
      organiser,
      ...detail.attendees.filter((attendee) => !attendee.resource && !attendee.self),
    ];
    words.push(
      detail.calendar.name,
      ...people.flatMap((person) => (person ? [person.name ?? '', person.email] : [])),
    );
  } else if (
    detail?.kind === 'pull-request' ||
    detail?.kind === 'github-issue' ||
    detail?.kind === 'github-release'
  ) {
    // A GitHub Item by what a Rule matches (#118): its repo, labels and author, never its body.
    const repo = `${detail.repo.owner}/${detail.repo.name}`;
    const labels = detail.kind === 'github-release' ? [] : detail.labels.map((label) => label.name);
    const facts = [`repo ${repo}`, ...labels, ...(detail.author ? [`by ${detail.author}`] : [])];
    const name =
      detail.kind === 'github-release'
        ? `GitHub release ${repo} ${detail.tag}`
        : `GitHub ${detail.kind === 'pull-request' ? 'pull request' : 'issue'} ${repo}#${detail.number}`;
    subject = `${name} (${facts.join(' · ')})`;
    words.push(repo, detail.repo.owner, detail.repo.name, ...labels, detail.author ?? '');
  } else if (detail?.kind === 'email') {
    // An email (#141) by its sender's address and mailing list, never its words nor the sender's
    // display name; found by its sender, domains, list and subject too.
    subject = emailSubject(detail);
    words.push(
      detail.from?.address.toLowerCase() ?? '',
      ...senderDomains(detail),
      detail.listId ?? '',
      detail.subject,
    );
  } else if (detail?.kind === 'block') {
    subject = `“${cut(detail.text, MAX_TITLE)}”`;
  }
  // An email's person is its sender: its recipients (the User among them) say nothing about it.
  const sender = detail?.kind === 'email' ? detail.from?.address.trim().toLowerCase() : undefined;
  const handles =
    detail?.kind === 'email'
      ? sender
        ? [sender]
        : []
      : identitiesOf(item).map((identity) => identity.handle);
  return { subject, words: words.filter(Boolean).join(' '), handles };
}

export type RecallRequest = {
  // What the job is working on: its words, and who and what it involves.
  text: string;
  handles?: readonly string[];
  projectIds?: readonly string[];
  kinds?: readonly MemoryKind[];
  limit?: number;
  // The text embedded, when search by meaning is ready.
  meaning?: QueryVector | null;
  // Memories the job puts in its prompt itself (an Account's writing style, #143): left out here.
  except?: readonly string[];
  // Only what the User confirmed, as their own material: a Conversation recalls these with every
  // message (#194), where background would hold back whatever his Skills then do.
  confirmedOnly?: boolean;
};

// What a job looks Memory up by meaning with (#73): the text embedded, or null while the embedding
// model isn't ready.
export type MeaningLookup = (text: string) => Promise<QueryVector | null>;

const KIND_WORDS: Record<MemoryKind, string> = {
  example: 'example',
  fact: 'fact',
  preference: 'preference',
  rule: 'rule',
};

const line = (memory: RecalledMemory) => `- (${KIND_WORDS[memory.kind]}) ${memory.text}`;

/**
 * The memories about what a job is working on, as data blocks: the confirmed ones as the User's own
 * material, the unconfirmed as background (with the outside Items they came from). None when Memory
 * holds nothing relevant.
 */
export function recall(itemStore: ItemStore, request: RecallRequest): PromptData[] {
  const except = new Set(request.except ?? []);
  const found = itemStore.memory
    .lookup({
      text: request.text,
      handles: request.handles,
      projectIds: request.projectIds,
      kinds: request.kinds,
      limit: request.limit,
      meaning: request.meaning ?? undefined,
    })
    .filter((memory) => !except.has(memory.id));
  const confirmed = found.filter((memory) => memory.confirmed);
  const unconfirmed = request.confirmedOnly ? [] : found.filter((memory) => !memory.confirmed);
  const data: PromptData[] = [];
  if (confirmed.length) {
    data.push({ label: 'What Ares knows', from: 'user-settings', text: confirmed.map(line).join('\n') });
  }
  if (unconfirmed.length) {
    const sources = new Map<string, Item>();
    for (const memory of unconfirmed) {
      for (const source of memory.sources) {
        const item = itemStore.get(source.itemId)?.item;
        if (item) sources.set(item.id, item);
      }
    }
    data.push({
      label: 'What Ares has picked up (unconfirmed)',
      from: { background: [...sources.values()] },
      text: unconfirmed.map(line).join('\n'),
    });
  }
  return data;
}
