import {
  type Conversation,
  type ConversationLink,
  type ConversationsRequest,
  type ConversationsResults,
  type ConversationTurn,
  type ConversationView,
  conversationName,
  skillTitle,
} from '@commander/domain';
import type { AresTextRef } from '@commander/ui';
import { type OpenTarget, sectionOf } from '../../updates/updates';
import { dayLabel, longDate, weekday } from '../notes/days';

// The longest an Item's title shows in a link.
const LINK_TITLE = 48;

/** Where an answer's link to an Item opens it: in its Section. */
export const linkTarget = (link: ConversationLink): OpenTarget => ({
  kind: 'item',
  sectionId: sectionOf(link.section),
  itemId: link.itemId,
});

/**
 * An answer's links as AresText draws them (#192): each named by its Source's short name (ENG-418)
 * or its title, opening its Item where it lives.
 */
export function refsOf(
  links: readonly ConversationLink[],
  open: (target: OpenTarget) => void,
): ReadonlyMap<string, AresTextRef> {
  return new Map(
    links.map((link) => {
      const title = link.title.trim() || 'Untitled';
      const text =
        link.label ?? (title.length > LINK_TITLE ? `${title.slice(0, LINK_TITLE - 1).trimEnd()}…` : title);
      return [
        link.ref,
        {
          text,
          label: `Open ${link.label ? `${link.label} ${title}` : title}`,
          onOpen: () => open(linkTarget(link)),
        },
      ];
    }),
  );
}

const DOING: Record<string, string> = {
  find: 'Looking it up',
  update: 'Putting your Update together',
  summarise: 'Gathering what to sum up',
};

/** What Ares is doing before he writes, while a Skill runs: "Looking it up…". */
export function doingOf(turn: Pick<ConversationTurn, 'status' | 'skills'>): string | null {
  const skill = turn.skills.at(-1);
  if (turn.status !== 'streaming' || !skill) return null;
  return `${DOING[skill] ?? `Using ${skillTitle({ name: skill })}`}…`;
}

// Conversations with Ares (#191), as the window keeps them: what it asks the Core, and how it puts
// the Core's word about a turn (a reply, or a turn pushed as it changes) together.

/** The window's way to Conversations (window.commander.conversations, or a test's stand-in). */
export type ConversationsClient = <R extends ConversationsRequest>(
  request: R,
) => Promise<ConversationsResults[R['op']]>;

const FINISHED = new Set(['done', 'stopped', 'failed']);

/**
 * A turn as the window shows it: the newer of what a reply said and what the Core pushed since (a
 * finished turn never goes back to waiting or writing).
 */
export function newerTurn(known: ConversationTurn | undefined, turn: ConversationTurn): ConversationTurn {
  if (!known) return turn;
  if (FINISHED.has(known.status) && !FINISHED.has(turn.status)) return known;
  if (known.status === 'streaming' && turn.status === 'queued') return known;
  return turn;
}

/** A Conversation as a reply showed it, with any turn the Core has pushed since. */
export function withPushedTurns(
  view: ConversationView,
  pushed: ReadonlyMap<number, ConversationTurn>,
): ConversationView {
  return { ...view, turns: view.turns.map((turn) => newerTurn(pushed.get(turn.id), turn)) };
}

/** A Conversation with one of its turns as the Core pushed it (added when it is new). */
export function withTurn(view: ConversationView, turn: ConversationTurn): ConversationView {
  if (turn.conversationId !== view.conversation.id) return view;
  const at = view.turns.findIndex((each) => each.id === turn.id);
  const turns =
    at === -1
      ? [...view.turns, turn].sort((a, b) => a.id - b.id)
      : view.turns.map((each, index) => (index === at ? newerTurn(each, turn) : each));
  const answering = turns.some((each) => each.status === 'queued' || each.status === 'streaming');
  return { conversation: { ...view.conversation, answering }, turns };
}

/** The answer Ares is giving (or waiting to give) in a Conversation, if any. */
export const answeringTurn = (view: ConversationView | null) =>
  view?.turns.find((turn) => turn.status === 'queued' || turn.status === 'streaming') ?? null;

/** Whether the User can Send again: his last answer failed, or was stopped before he wrote anything. */
export function canSendAgain(view: ConversationView | null): boolean {
  const last = view?.turns.at(-1);
  return (
    last?.by === 'ares' &&
    (last.status === 'failed' || (last.status === 'stopped' && last.text.trim() === ''))
  );
}

/** How the list and the thread name a Conversation: its first words, or its day while untitled. */
export function nameOf(conversation: Pick<Conversation, 'title' | 'daily' | 'day'>, today: string): string {
  const day = dayLabel(conversation.day, today);
  const untitledDaily =
    day === 'Today' || day === 'Yesterday'
      ? day
      : `${weekday(conversation.day)} ${longDate(conversation.day)}`;
  return conversationName(conversation, untitledDaily);
}

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

/** When a Conversation was last written in: the time today, the date before. */
export function lastWritten(at: number, today: string): string {
  const day = new Date(at);
  const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  return key === today ? time.format(day) : date.format(day);
}
