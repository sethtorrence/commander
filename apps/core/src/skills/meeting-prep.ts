// Meeting prep (#130, #198, decision #24): "prep me for the 2pm" from a Conversation. Ares finds the
// event, and this runs "Prepare for meetings" for it exactly as Prepare now on its chip does (the job
// gathers the material in code, reads it through the prompt builder and keeps the prep as Ares's own
// Item, ADR 0004's second amendment), then shows the prep under his answer, linked to the event
// (`made`). Nothing here changes an Item of the User's, so nothing goes to the gate; the Todos the
// meeting asks for are still the job's suggestions on the event.
//
// What Ares is told is Commander's note that the prep is there, and the prep's lines as background
// (Ares wrote them from outside content, as an Update's lines are), so he can answer about them; a
// meeting that gets no prep (declined, all-day, no one else in it) or a prep switched off is said
// plainly in Commander's words.
import {
  decide,
  type EventDetail,
  type Item,
  isMeetingPrep,
  MEETING_PREP_NEEDS,
  MEETING_PREP_SKILL,
  type MeetingPrepInput,
  meetingPrepInput,
  otherAttendees,
  PREPARE_MEETINGS,
  PREPARE_MEETINGS_NAME,
  prepLines,
  prepSources,
  type Skill,
} from '@commander/domain';
import type { JobRunner } from '../agent/runner';
import type { ItemStore } from '../item-store';
import { handedItem } from './act';
import type { Findings } from './findings';

export type MeetingPrepSkillOptions = {
  itemStore: Pick<ItemStore, 'get' | 'meetingPreps' | 'autonomy'>;
  // Ares's jobs: "Prepare for meetings" is run for the event, and waited for.
  runner: Pick<JobRunner, 'run' | 'settled' | 'jobs'>;
  now?: () => number;
};

const TITLE = MEETING_PREP_SKILL.title as string;

/** Why an event gets no prep, in Commander's words; null when it does (it is prep-worthy). */
export function whyNoPrep(item: Item): string | null {
  if (item.kind !== 'event' || item.detail?.kind !== 'event') return 'it isn’t a calendar event';
  const detail: EventDetail = item.detail;
  if (detail.createdByCommander) return 'it is time Commander holds in the User’s calendar, not a meeting';
  if (detail.allDay) return 'it is an all-day event, not a meeting';
  if (detail.myResponse === 'declined') return 'the User declined it';
  if (!detail.busy) return 'it is marked free, not a meeting the User is in';
  if (!otherAttendees(detail).length) return 'no one else is in it, so there is nothing to prepare';
  return null;
}

const notDone = (ref: string, why: string): Findings => ({
  note: `${TITLE}: Not done: preparing ${ref}: ${why}. Tell the User plainly, in a sentence.`,
  items: [],
  more: [],
});

export function createMeetingPrepSkill(options: MeetingPrepSkillOptions): Skill<MeetingPrepInput, Findings> {
  const { itemStore, runner } = options;
  const now = options.now ?? Date.now;

  return {
    ...MEETING_PREP_SKILL,
    input: { schema: meetingPrepInput, describe: MEETING_PREP_NEEDS },
    async run(input, context = {}) {
      const ref = input.event.trim();
      const event = handedItem(context, itemStore, ref);
      const why = whyNoPrep(event);
      if (why || event.detail?.kind !== 'event') return notDone(ref, why ?? 'it isn’t a calendar event');
      const off =
        decide(
          {
            action: PREPARE_MEETINGS,
            actionKind: 'organise',
            section: 'calendar',
            confidence: 1,
            chained: false,
          },
          itemStore.autonomy.settings(),
        ) === 'off';
      if (off) return notDone(ref, `${PREPARE_MEETINGS_NAME} is Off in Settings → Autonomy`);
      if (runner.jobs().find((job) => job.job === PREPARE_MEETINGS)?.enabled === false)
        return notDone(ref, `${PREPARE_MEETINGS_NAME} is switched off in Settings → Ares`);

      // Prepare now: always prepared again, then waited for.
      const asked = now();
      runner.run(PREPARE_MEETINGS, [event.id]);
      await runner.settled();
      const prep = itemStore.meetingPreps([event.id]).find(isMeetingPrep);
      if (!prep || prep.detail.preparedAt < asked) {
        throw new Error(
          runner.jobs().find((job) => job.job === PREPARE_MEETINGS)?.lastProblem ?? 'no prep was made',
        );
      }

      const lines = prepLines(prep.detail).map((line) => `- ${line.text}`);
      const sources = prepSources(prep.detail).flatMap((itemId) => itemStore.get(itemId)?.item ?? []);
      return {
        note: `${TITLE}: the prep for ${ref} is ready and shows under your answer, linked to the event. ${lines.length ? `Its lines are in the block “Meeting prep for ${ref}”, as background. Don’t repeat them: lead in with a sentence at most, or answer anything else the User asked.` : 'It found nothing that holds up to prepare: say so in a sentence.'} Don’t use ${TITLE} again for the same meeting.`,
        items: [],
        more: lines.length
          ? [
              {
                label: `Meeting prep for ${ref}`,
                from: { background: [event, ...sources] },
                text: lines.join('\n'),
              },
            ]
          : [],
        made: [
          {
            kind: 'meeting-prep',
            eventId: event.id,
            title: event.title,
            startsAt: event.detail.start.at,
          },
        ],
      };
    },
  };
}
