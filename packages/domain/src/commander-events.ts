import { z } from 'zod';
import { commanderEventKind, eventTime } from './calendar';
import { filing } from './items';

/*
  Events Commander itself writes to a calendar (#131), the first time it creates events: focus blocks,
  in a calendar named "Commander" in the Account the User chooses, and busy copies of another Account's
  events on an Account's main calendar. Both are busy and private, with no description, guests or
  reminders; a busy copy is titled "Busy" and carries nothing of the event it copies.

  They take ADR 0003's path: the Item store makes the event's Item at once and queues its creation as the
  outgoing change `create` in the same transaction, so undo, offline and Couldn't sync behave as for any
  other write. The Item's id is Commander's id for the event, from which the Google event id and the
  Microsoft `transactionId` are made, so a retried create never makes a second event. Until the Source
  has it, the Item's external id is a placeholder (`commander:<item id>`); the event as the Source answers
  it names that Item (`commanderItemId`), and saving it gives the Item its real external id.

  Moving one queues `time` (start and end together); deleting one (or undoing its creation) queues
  `delete`. Each calendar adapter carries out `create`, `time` and `delete` for the events it has.
*/

const id = z.string().min(1);

// The calendar Commander makes for focus blocks, found again by this name after a re-sync.
export const COMMANDER_CALENDAR_NAME = 'Commander';
// A busy copy's title, the only thing it shows.
export const BUSY_COPY_TITLE = 'Busy';
// The outgoing change that moves a Commander event: its new start and end.
export const MOVE_FIELD = 'time';

const PENDING_PREFIX = 'commander:';

/** The placeholder external id of a Commander event its Source doesn't have yet. */
export const pendingEventExternalId = (itemId: string) => `${PENDING_PREFIX}${itemId}`;

/** Whether an external id is a placeholder: the event hasn't reached its Source yet. */
export const isPendingEventExternalId = (externalId: string | null) =>
  !!externalId && externalId.startsWith(PENDING_PREFIX);

// The `create` change's value: everything an adapter needs to make the event.
export const commanderEventCreate = z.object({
  kind: commanderEventKind,
  // The calendar it goes on: its id at the Source, or null for the Commander calendar, which the adapter
  // finds (by name, among the Account's own calendars) or makes on first use.
  calendarId: id.nullable(),
  // Commander's id for the event: its Item's id, a UUID.
  commanderId: z.uuid(),
  title: z.string().min(1),
  start: eventTime,
  end: eventTime,
  allDay: z.boolean(),
});
export type CommanderEventCreate = z.infer<typeof commanderEventCreate>;

// The `time` change's value.
export const commanderEventMove = z.object({ start: eventTime, end: eventTime, allDay: z.boolean() });
export type CommanderEventMove = z.infer<typeof commanderEventMove>;

// What a job, the gate or busy copying hands the Item store to make one (the `create-event` action).
export const commanderEventDraft = z.object({
  kind: commanderEventKind,
  // The Account it goes in: a focus block in its Commander calendar, a busy copy on its main calendar.
  account: id,
  title: z.string().trim().min(1).max(300),
  start: eventTime,
  end: eventTime,
  allDay: z.boolean().default(false),
  // A focus block takes its Todo's Project, as inherited.
  filing: filing.optional(),
  // A busy copy: the event it copies.
  copyOf: id.optional(),
});
export type CommanderEventDraft = z.input<typeof commanderEventDraft>;
