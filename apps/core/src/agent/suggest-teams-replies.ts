// Ares prepares a reply for each Chat waiting on the User (#110): "Suggest Teams replies", a Deep job.
// When "Spot what's waiting on you" (#109) flags a Chat, the User finds a reply ready to look at.
//
// - Runs after each Teams sync and whenever Ares flags a Chat (or on request), on the unmuted Chats
//   whose flag still stands and has no suggested reply yet: once per flag (remembered by the flagged
//   message), so a dismissed one isn't prepared again until someone asks something new.
// - One Chat per call, in an outside data block of its own, with its latest messages and the message
//   the User needs to answer (draft-reply.ts, the same prompt as Draft). What it says is never an
//   instruction.
// - Registered as Act for you, "Reply in Teams": a reply is seen by other people, so the gate only
//   ever keeps it as a suggestion, whatever the Autonomy settings say, and it is accepted one at a
//   time. Its one step is the reply the User would write (the Chat's synced field
//   `message:<clientId>`), which the gate carries out as the User when they press Send: the same
//   outgoing queue as any reply, recorded as the User's on Ares's suggestion. The Item store refuses
//   a reply from Ares himself, so nothing reaches Teams without the User.
// - A suggestion whose flag has gone (the User answered, Ares judged it settled, the User said it
//   isn't waiting) or been replaced by a newer one is withdrawn (`dismissSettledReplies`).

import { randomUUID } from 'node:crypto';
import {
  MESSAGE_FIELD,
  mutedChatIds,
  REPLY_IN_TEAMS,
  SUGGEST_TEAMS_REPLIES,
  stillWaiting,
} from '@commander/domain';
import type { z } from 'zod';
import type { Gate } from '../autonomy/gate';
import type { ItemStore } from '../item-store';
import { type Chat, isChat, whoAmIIn } from './chat-material';
import { cleanDraft, draftPrompt, OUTPUT } from './draft-reply';
import type { PromptParts } from './prompt';
import type { AgentJob, JobInput, JobProposal } from './runner';
import { liveChats } from './spot-waiting';

// At most this many Chats a run (one call each).
const MAX_CHATS = 5;

type Output = z.infer<typeof OUTPUT>;
type Candidate = { itemId: string; messageId: string; reason: string; prompt: PromptParts };
type Input = JobInput & { candidates: Candidate[] };

// What the job remembers a flag by: the message it is on.
const fingerprintOf = (messageId: string) => `flag:${messageId}`;

/**
 * The pending "Reply in Teams" suggestions whose Chat is no longer waiting on the User for what they
 * answered (the flag went, or a newer one replaced it), or is gone: Commander withdraws them. Returns
 * their ids.
 */
export function dismissSettledReplies(itemStore: ItemStore, gate: Pick<Gate, 'dismiss'>) {
  const stale = itemStore.autonomy
    .proposals({ action: REPLY_IN_TEAMS, statuses: ['pending'], limit: 1000 })
    .filter((proposal) => {
      const chat = itemStore.get(proposal.itemId)?.item;
      return !chat || chat.deletedAt !== null || !chat.waiting || chat.waiting.at > proposal.at;
    })
    .map((proposal) => proposal.id);
  for (const id of stale) gate.dismiss(id);
  return stale;
}

export function suggestTeamsRepliesJob(
  itemStore: ItemStore,
  {
    now = Date.now,
    me = () => null,
  }: {
    now?: () => number;
    // Who the User is in a Teams Account (their Microsoft user id), from Source sync, when known.
    me?: (account: string) => string | null;
  } = {},
): AgentJob<Input, Output> {
  const waiting = () =>
    new Set(
      itemStore.autonomy
        .proposals({ action: REPLY_IN_TEAMS, statuses: ['pending'], limit: 1000 })
        .map((proposal) => proposal.itemId),
    );

  return {
    job: SUGGEST_TEAMS_REPLIES,
    name: 'Suggest Teams replies',
    tier: 'deep',
    reasoningEffort: 'high',
    action: {
      action: REPLY_IN_TEAMS,
      name: 'Reply in Teams',
      actionKind: 'act-for-you',
      section: 'teams',
      hint: 'A reply ready to look at when someone in a Chat is waiting on you. Others see a reply, so it is only ever a suggestion, sent when you press Send',
    },
    triggers: { 'source-sync': true },

    gather({ triggers, seen }) {
      const teams = triggers.some(
        (trigger) =>
          trigger.kind === 'request' || (trigger.kind === 'source-sync' && trigger.source === 'teams'),
      );
      if (!teams) return null;
      // On request about some Chats (Ares just flagged them), only those.
      const asked = new Set(
        triggers.flatMap((trigger) => (trigger.kind === 'request' ? (trigger.itemIds ?? []) : [])),
      );
      const onlyAsked = asked.size > 0 && triggers.every((trigger) => trigger.kind === 'request');
      const at = now();
      const chats = new Map(liveChats(itemStore).map((chat) => [chat.id, chat]));
      const muted = mutedChatIds([...chats.values()], itemStore.chatSettings.list());
      const whoAmI = whoAmIIn(itemStore, me);
      const pending = waiting();
      const candidates: Candidate[] = [];
      for (const flag of itemStore.chatWaiting.flagged().sort((a, b) => b.at - a.at)) {
        if (candidates.length >= MAX_CHATS) break;
        if (onlyAsked && !asked.has(flag.itemId)) continue;
        const chat: Chat | undefined = chats.get(flag.itemId);
        if (!chat || muted.has(chat.id) || pending.has(chat.id)) continue;
        if (seen(chat.id, fingerprintOf(flag.messageId))) continue;
        const user = whoAmI(chat);
        if (!stillWaiting(chat.detail, flag, user)) continue;
        candidates.push({
          itemId: chat.id,
          messageId: flag.messageId,
          reason: flag.reason,
          prompt: draftPrompt(chat, user, at, flag),
        });
      }
      return {
        items: candidates.map((candidate) => ({
          itemId: candidate.itemId,
          fingerprint: fingerprintOf(candidate.messageId),
        })),
        candidates,
      };
    },

    // One Chat per call: what it says can only lead to a suggestion on itself.
    batch(input) {
      return input.candidates.map((candidate) => ({
        items: input.items.filter((item) => item.itemId === candidate.itemId),
        candidates: [candidate],
      }));
    },

    prompt: (input) => {
      const [candidate] = input.candidates;
      if (!candidate) throw new Error('Nothing to draft');
      return candidate.prompt;
    },

    output: OUTPUT,

    proposals(output, input) {
      const dropped: string[] = [];
      const proposals: JobProposal[] = [];
      const [candidate] = input.candidates;
      if (!candidate) return { proposals, dropped };
      const text = cleanDraft(output.draft);
      if (!text) {
        dropped.push('an empty draft');
        return { proposals, dropped };
      }
      // Answered, settled or gone while Ares was writing: nothing to suggest.
      const chat = itemStore.get(candidate.itemId)?.item;
      if (!isChat(chat) || chat.deletedAt !== null || chat.waiting?.messageId !== candidate.messageId) {
        return { proposals, dropped };
      }
      const reply = { clientId: randomUUID(), text, createdAt: now() };
      proposals.push({
        itemId: chat.id,
        itemActions: [
          { type: 'edit-fields', itemId: chat.id, fields: { [`${MESSAGE_FIELD}${reply.clientId}`]: reply } },
        ],
        confidence: 1,
        reason: candidate.reason,
        causedBy: { itemId: chat.id },
      });
      return { proposals, dropped };
    },
  };
}
