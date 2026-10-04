import { type FindTimeResult, guestAddress, type Person } from '@commander/domain';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  toast,
} from '@commander/ui';
import { useCallback, useEffect, useState } from 'react';
import type { ItemStoreClient } from '../../item-store/client';
import { useCommands } from '../../palette/commands';
import { MeetingCard } from './MeetingCard';
import { copyBookingLink, draftToCreate, type MeetingDraft, whenLabel } from './meetings';
import { useScheduling } from './use-scheduling';

/*
  Find time (#132): the palette's Find time… and the Calendar Section's button. Who (addresses, with
  suggestions from People's addresses), how long, and within when; Commander shows up to 5 slots from
  the User's free time across every Account, narrowed by the guests' free/busy where a provider shares
  it, and says whose calendars couldn't be checked. Picking a slot opens the meeting card; a guest
  outside the User's organisations brings Send your booking link instead.
*/

const LENGTHS = [15, 30, 45, 60, 90, 120];
const WITHIN: [number, string][] = [
  [5, 'The next 5 days'],
  [7, 'The next week'],
  [14, 'The next 2 weeks'],
  [30, 'The next 30 days'],
];
const DAY_MS = 24 * 60 * 60_000;

const selectClass =
  'h-8 min-w-0 border border-line bg-sheet px-2 font-sans text-note text-ink outline-none focus-visible:border-ink';
const labelClass = 'font-mono text-label leading-none font-semibold uppercase tracking-label text-muted';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Find time asked for from anywhere (the Calendar Section's button): the host opens.
const listeners = new Set<() => void>();
export function requestFindTime(): void {
  for (const listener of listeners) listener();
}

/** The guests typed, as addresses; null with one that isn't. */
export function guestsOf(text: string): string[] | null {
  const parts = text
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const parsed = parts.map((part) => guestAddress.safeParse(part));
  if (parsed.some((each) => !each.success)) return null;
  return [...new Set(parsed.map((each) => (each.success ? each.data : '')))];
}

/** "Meeting with Leo Park and dana@contoso.test" */
function titleFor(guests: readonly string[], people: readonly Person[]): string {
  const nameOf = (email: string) =>
    people.find((person) => person.handles.some((handle) => handle.handle.toLowerCase() === email))?.name ??
    email;
  if (!guests.length) return 'Meeting';
  const names = guests.map(nameOf);
  return `Meeting with ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}`;
}

/** The palette command and the dialog, mounted once in the frame. */
export function FindTimeHost({ itemStore = window.commander.itemStore }: { itemStore?: ItemStoreClient }) {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  useEffect(() => {
    listeners.add(show);
    return () => {
      listeners.delete(show);
    };
  }, [show]);
  useCommands([{ label: 'Find time…', group: 'Calendar', run: show }]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {open && <FindTimeDialog itemStore={itemStore} onClose={() => setOpen(false)} />}
    </Dialog>
  );
}

function FindTimeDialog({ itemStore, onClose }: { itemStore: ItemStoreClient; onClose(): void }) {
  const scheduling = useScheduling(itemStore, true);
  const [people, setPeople] = useState<Person[]>([]);
  const [who, setWho] = useState('');
  const [length, setLength] = useState(30);
  const [within, setWithin] = useState(7);
  const [found, setFound] = useState<FindTimeResult | null>(null);
  const [looking, setLooking] = useState(false);
  const [draft, setDraft] = useState<MeetingDraft | null>(null);
  const timeZone = found?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    itemStore({ op: 'people' }).then(setPeople, () => {});
  }, [itemStore]);
  const suggestions = [
    ...new Set(
      people
        .filter((person) => !person.isUser)
        .flatMap((person) =>
          person.handles.filter((handle) => handle.source === 'email').map((h) => h.handle),
        ),
    ),
  ];

  const find = async () => {
    const guests = guestsOf(who);
    if (!guests) return toast('Each guest needs an email address');
    setLooking(true);
    setDraft(null);
    try {
      const now = Date.now();
      setFound(
        await itemStore({
          op: 'find-time',
          request: { attendees: guests, durationMinutes: length, from: now, to: now + within * DAY_MS },
        }),
      );
    } catch (error) {
      toast(message(error));
    } finally {
      setLooking(false);
    }
  };

  const pick = (slot: { start: number; end: number }) => {
    const target = scheduling.newEvents;
    if (!target) return toast('Connect a calendar Account in Settings → Accounts first');
    const guests = found?.guests.map((guest) => guest.email) ?? [];
    setDraft({
      title: titleFor(guests, people),
      start: slot.start,
      end: slot.end,
      account: target.account,
      calendarId: target.calendarId,
      guests: guests.map((email) => ({ email, name: null })),
      toFill: [],
      timeZone,
    });
  };

  const create = async (meeting: MeetingDraft) => {
    try {
      await itemStore({ op: 'create-meeting', draft: draftToCreate(meeting) });
      toast(
        meeting.guests.length
          ? `“${meeting.title}” is in your calendar, and the invitations are on their way`
          : `“${meeting.title}” is in your calendar`,
      );
      onClose();
    } catch (error) {
      toast(message(error));
    }
  };

  const outside = found?.guests.filter((guest) => guest.outside) ?? [];
  return (
    <DialogContent
      aria-describedby={undefined}
      className="w-[min(640px,calc(100vw-48px))]"
      data-testid="find-time"
    >
      <DialogHeader partNumber="CAL">
        <DialogTitle>Find time</DialogTitle>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3.5">
        <form
          aria-label="Find time"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void find();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="find-time-who" className={labelClass}>
              Who
            </label>
            <Input
              id="find-time-who"
              autoFocus
              placeholder="Their email addresses, separated by commas"
              list="find-time-people"
              value={who}
              onChange={(event) => setWho(event.target.value)}
            />
            <datalist id="find-time-people">
              {suggestions.map((email) => (
                <option key={email} value={email} />
              ))}
            </datalist>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5">
              <span className={labelClass}>How long</span>
              <select
                aria-label="How long"
                value={length}
                onChange={(event) => setLength(Number(event.target.value))}
                className={selectClass}
              >
                {LENGTHS.map((each) => (
                  <option key={each} value={each}>
                    {each < 60 ? `${each} min` : `${each / 60} h`}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={labelClass}>Within</span>
              <select
                aria-label="Within"
                value={within}
                onChange={(event) => setWithin(Number(event.target.value))}
                className={selectClass}
              >
                {WITHIN.map(([days, label]) => (
                  <option key={days} value={days}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" variant="signal" disabled={looking}>
              {looking ? 'Looking…' : 'Find time'}
            </Button>
          </div>
        </form>
        {found && !draft && (
          <section aria-label="Free times" className="flex flex-col gap-2">
            {found.slots.length ? (
              <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Free times">
                {found.slots.map((slot) => (
                  <li key={slot.start}>
                    <Button onClick={() => pick(slot)}>{whenLabel(slot.start, timeZone)}</Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-note text-faint">No free time then, inside your working hours.</p>
            )}
            {found.guests.map((guest) => (
              <p key={guest.email} className="m-0 text-note text-muted" data-testid="guest-checked">
                {guest.email}: {guest.checked ? 'their calendar was checked too.' : guest.why}
              </p>
            ))}
            {found.bookingLink && outside.length > 0 && (
              <Button
                className="self-start"
                variant="ghost"
                onClick={() => void copyBookingLink(found.bookingLink as string)}
              >
                Send your booking link instead
              </Button>
            )}
          </section>
        )}
        {draft && (
          <section aria-label="New event" className="border border-line p-3">
            <MeetingCard
              variant="dialog"
              draft={draft}
              onChange={setDraft}
              timeZone={timeZone}
              accounts={scheduling.accounts}
              calendars={scheduling.calendars}
              bookingLink={scheduling.bookingLink}
              itemStore={itemStore}
              onCreate={() => void create(draft)}
              onHandedOff={(where) => {
                toast(`Opened in ${where}: finish it there`);
                onClose();
              }}
            />
          </section>
        )}
      </DialogBody>
      <DialogFooter>
        {draft && <Button onClick={() => setDraft(null)}>Back to times</Button>}
        <Button onClick={onClose}>Close</Button>
      </DialogFooter>
    </DialogContent>
  );
}
