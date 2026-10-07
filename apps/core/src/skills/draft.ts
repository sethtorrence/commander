// Draft (#143, #110, #198, decision #24): the User tells Ares to write their reply from a Conversation
// ("reply to this saying Thursday works", "draft a reply to Priya's last Chat"). It is the Draft call
// the Email and Teams Sections make on request, unchanged: an email thread gets its suggested reply
// (draft-email-reply.ts, kept beside the thread and replacing any), a Chat a draft for its reply box
// (draft-reply.ts), each in the User's own style, each reading the thread or Chat in its own prompt.
//
// - What the reply should say is the User's own message in the Conversation, handed to the draft as
//   their material, never the model's paraphrase of it: what a Skill found can't put words in the
//   User's mouth.
// - The draft changes no Item and nothing at the Source (ADR 0004, eleventh amendment), so nothing goes
//   to the gate. The answer shows it under his words (`made`), with Open in composer: the email's
//   suggested reply opened as an ordinary Draft, or the text put in the Chat's reply box, for the User
//   to edit and send. Ares can't save or send a message; the gate refuses it and the Item store too.
// - What Ares is told is Commander's own note: that the draft is there, never its words, and that it
//   hasn't been sent.
import {
  type ChatDraft,
  type ConversationMade,
  DRAFT_NEEDS,
  DRAFT_SKILL,
  type DraftEmailRequest,
  type DraftInput,
  draftInput,
  MAX_DRAFT_INSTRUCTION,
  type ReadyReply,
  type Skill,
  type SkillContext,
} from '@commander/domain';
import { EmailDraftFailed } from '../agent/draft-email-reply';
import { DraftFailed } from '../agent/draft-reply';
import type { ItemStore } from '../item-store';
import { handedItem } from './act';
import type { Findings } from './findings';

export type DraftSkillOptions = {
  itemStore: Pick<ItemStore, 'get'>;
  // The Teams Section's Draft: a reply for a Chat's reply box.
  draftChat: (itemId: string, instruction?: string) => Promise<ChatDraft>;
  // The Email Section's Draft a reply: the thread's suggested reply, kept and returned.
  draftEmail: (request: DraftEmailRequest) => Promise<ReadyReply>;
};

const TITLE = DRAFT_SKILL.title as string;

/** What the reply should say: the User's own message, as their material, cut to what a draft takes. */
export function instructionFrom(context: SkillContext): string | undefined {
  const words = context.asked?.trim();
  return words ? words.slice(0, MAX_DRAFT_INSTRUCTION) : undefined;
}

function drafted(ref: string, made: ConversationMade, sure = true): Findings {
  return {
    note: `${TITLE}: a draft of the User’s reply to ${ref} is ready and shows under your answer, with Open in composer, for the User to edit and send themselves.${sure ? '' : ' It isn’t one Ares is sure of: the User should read it closely.'} It hasn’t been sent, and nothing is sent from a Conversation: never say it was. Don’t repeat the draft: say in a sentence that it is there, naming ${ref}. Don’t use ${TITLE} again for the same reply.`,
    items: [],
    more: [],
    made: [made],
  };
}

const notDrafted = (ref: string, why: string): Findings => ({
  note: `${TITLE}: Not done: drafting a reply to ${ref}: ${why.replace(/[.\s]+$/, '')}. Tell the User plainly, in a sentence.`,
  items: [],
  more: [],
});

export function createDraftSkill({
  itemStore,
  draftChat,
  draftEmail,
}: DraftSkillOptions): Skill<DraftInput, Findings> {
  return {
    ...DRAFT_SKILL,
    input: { schema: draftInput, describe: DRAFT_NEEDS },
    async run(input, context = {}) {
      const ref = input.item.trim();
      const item = handedItem(context, itemStore, ref);
      const instruction = instructionFrom(context);
      try {
        if (item.kind === 'email') {
          const reply = await draftEmail({ itemId: item.id, ...(instruction && { instruction }) });
          return drafted(
            ref,
            {
              kind: 'email-draft',
              itemId: reply.answering,
              title: item.title,
              body: reply.body,
              addedLinks: reply.addedLinks,
              sure: reply.sure,
            },
            reply.sure,
          );
        }
        if (item.kind === 'chat') {
          const draft = await draftChat(item.id, instruction);
          return drafted(ref, { kind: 'chat-draft', itemId: item.id, title: item.title, text: draft.text });
        }
      } catch (error) {
        // Commander's own words for why (switched off, mail he may not read, nothing to reply to).
        if (error instanceof DraftFailed || error instanceof EmailDraftFailed)
          return notDrafted(ref, error.message);
        throw error;
      }
      return notDrafted(ref, 'it isn’t an email or a Teams Chat, so it has no reply to draft');
    },
  };
}
