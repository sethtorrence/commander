import {
  type CalendarSummary,
  clashesAt,
  type EventDetail,
  type FindTimeResult,
  guestAddress,
} from '@commander/domain';
import { AresText, Button, cn, toast } from '@commander/ui';
import { type ComponentProps, useEffect, useState } from 'react';
import type { ItemStoreClient } from '../../item-store/client';
import { addressOf, type CalendarAccount } from './calendar-events';
import {
  copyBookingLink,
  editorFor,
  headline,
  lengthLabel,
  type MeetingDraft,
  outsideGuests,
  whenLabel,
  writableCalendars,
} from './meetings';

/*
  The meeting card (#132), in a Daily Note's margin beside the Block Ares proposed it for, and in Find
  time once a time is picked: its title, guests (a name Ares couldn't place waits as a blank to fill
  in), length, the time with "You're free" or what it clashes with, and the Account and calendar it
  goes in. Create makes it; Other times asks Find time for more; Edit in Google Calendar / Outlook hands
  it to the Account's own editor; Send your booking link instead copies the User's booking link when a
  guest is outside their organisations. Commander builds no event editor beyond this card.
*/

const LENGTHS = [15, 30, 45, 60, 90, 120];
const OTHER_TIMES_DAYS = 14;
const DAY_MS = 24 * 60 * 60_000;

const fieldClass =
  'h-7 min-w-0 border border-line bg-sheet px-1.5 font-sans text-note text-ink outline-none focus-visible:border-ink';
const labelClass = 'font-mono text-label leading-none font-semibold uppercase tracking-label text-muted';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Whether the User is free at the draft's time across every calendar, or what it clashes with.
function useClashes(itemStore: ItemStoreClient, draft: MeetingDraft): string[] | null {
  const [clashes, setClashes] = useState<string[] | null>(null);
  useEffect(() => {
    let current = true;
    itemStore({ op: 'events', query: { from: draft.start, to: draft.end } }).then(
      (items) => {
        if (!current) return;
        const events = items.flatMap((item) =>
          item.detail?.kind === 'event' ? [{ title: item.title, detail: item.detail as EventDetail }] : [],
        );
        setClashes(clashesAt({ start: draft.start, end: draft.end }, events).map((each) => each.title));
      },
      () => current && setClashes(null),
    );
    return () => {
      current = false;
    };
  }, [itemStore, draft.start, draft.end]);
  return clashes;
}

// One of the card's buttons: the margin card's flat ones, or the dialog's.
function Action({
  card,
  primary = false,
  ...props
}: { card: boolean; primary?: boolean } & Omit<ComponentProps<'button'>, 'type'>) {
  if (card) return <button type="button" className={primary ? 'n-ac-add' : 'n-ac-dismiss'} {...props} />;
  return <Button size="sm" variant={primary ? 'signal' : 'ghost'} {...props} />;
}

export interface MeetingCardProps {
  draft: MeetingDraft;
  onChange(draft: MeetingDraft): void;
  timeZone: string;
  accounts: readonly CalendarAccount[];
  calendars: readonly CalendarSummary[];
  bookingLink: string | null;
  itemStore: ItemStoreClient;
  /** Ares's reason, and the text his words may link to. */
  reason?: { text: string; sources: string[] };
  /** What the editor gets as the event's description. */
  details?: string;
  onCreate(): void;
  /** After handing the meeting to the provider's editor. */
  onHandedOff?(where: string): void;
  onDismiss?(): void;
  /** The margin's card styles, or the dialog's. */
  variant: 'margin' | 'dialog';
}

export function MeetingCard({
  draft,
  onChange,
  timeZone,
  accounts,
  calendars,
  bookingLink,
  itemStore,
  reason,
  details,
  onCreate,
  onHandedOff,
  onDismiss,
  variant,
}: MeetingCardProps) {
  const clashes = useClashes(itemStore, draft);
  const [filling, setFilling] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState('');
  const [other, setOther] = useState<FindTimeResult | 'loading' | null>(null);
  const minutes = Math.round((draft.end - draft.start) / 60_000);
  const account = accounts.find((each) => each.id === draft.account);
  const editor = editorFor(draft, account, details);
  const outside = outsideGuests(draft, accounts);
  const targets = accounts.flatMap((each) =>
    writableCalendars(calendars, each.id).map((calendar) => ({ account: each, calendar })),
  );
  const target = `${draft.account}\u0000${draft.calendarId ?? targets.find((each) => each.account.id === draft.account && each.calendar.primary)?.calendar.id ?? ''}`;

  const addGuest = (raw: string, name: string | null = null) => {
    const parsed = guestAddress.safeParse(raw);
    if (!parsed.success) {
      toast('That isn’t an email address');
      return false;
    }
    if (draft.guests.some((guest) => guest.email === parsed.data)) return true;
    onChange({ ...draft, guests: [...draft.guests, { email: parsed.data, name }] });
    return true;
  };
  const fill = (name: string) => {
    const raw = filling[name]?.trim() ?? '';
    const parsed = guestAddress.safeParse(raw);
    if (!parsed.success) return toast('That isn’t an email address');
    onChange({
      ...draft,
      guests: draft.guests.some((guest) => guest.email === parsed.data)
        ? draft.guests
        : [...draft.guests, { email: parsed.data, name }],
      toFill: draft.toFill.filter((each) => each !== name),
    });
  };
  const otherTimes = async () => {
    setOther('loading');
    try {
      const now = Date.now();
      setOther(
        await itemStore({
          op: 'find-time',
          request: {
            attendees: draft.guests.map((guest) => guest.email),
            durationMinutes: Math.min(Math.max(minutes, 15), 480),
            from: now,
            to: now + OTHER_TIMES_DAYS * DAY_MS,
          },
        }),
      );
    } catch (error) {
      setOther(null);
      toast(message(error));
    }
  };

  const status =
    clashes === null ? null : clashes.length ? `Clashes with ${clashes.join(', ')}` : 'You’re free';
  const card = variant === 'margin';
  return (
    <div className={cn(card ? 'n-ac-body' : 'flex flex-col gap-2')}>
      <label className="flex flex-col gap-1">
        <span className="sr-only">Title</span>
        <input
          aria-label="Title"
          value={draft.title}
          onChange={(event) => onChange({ ...draft, title: event.target.value })}
          className={cn(fieldClass, 'font-semibold')}
        />
      </label>
      <p className="m-0 mt-1 text-note text-ink" data-testid="meeting-headline">
        {headline(draft, timeZone)}
      </p>
      <p
        className={cn('m-0 text-note', clashes?.length ? 'text-signal-ink' : 'text-muted')}
        data-testid="meeting-status"
      >
        {whenLabel(draft.start, timeZone)}
        {status ? `, ${status.charAt(0).toLowerCase()}${status.slice(1)}` : ''}
      </p>
      <div className="mt-1 flex flex-col gap-1">
        <span className={labelClass}>Guests</span>
        {draft.guests.length > 0 && (
          <ul className="m-0 flex list-none flex-wrap gap-1 p-0" aria-label="Guests">
            {draft.guests.map((guest) => (
              <li
                key={guest.email}
                className="flex items-center gap-1 border border-line px-1.5 text-note text-ink"
              >
                <span title={guest.email}>{guest.name ? `${guest.name} · ${guest.email}` : guest.email}</span>
                <button
                  type="button"
                  className="cursor-pointer border-0 bg-transparent text-muted hover:text-ink"
                  aria-label={`Remove ${guest.email}`}
                  onClick={() =>
                    onChange({ ...draft, guests: draft.guests.filter((each) => each !== guest) })
                  }
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {draft.toFill.map((name) => (
          <div key={name} className="flex items-center gap-1">
            <input
              aria-label={`${name}’s email address`}
              placeholder={`${name}’s email address`}
              value={filling[name] ?? ''}
              onChange={(event) => setFilling((was) => ({ ...was, [name]: event.target.value }))}
              onKeyDown={(event) => {
                if (event.key === 'Enter') fill(name);
              }}
              className={cn(fieldClass, 'flex-1')}
            />
            <Button size="sm" variant="ghost" onClick={() => fill(name)}>
              Add
            </Button>
          </div>
        ))}
        <input
          aria-label="Add a guest"
          placeholder="Add a guest’s email address"
          value={adding}
          onChange={(event) => setAdding(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && adding.trim() && addGuest(adding)) setAdding('');
          }}
          className={fieldClass}
        />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5">
          <span className={labelClass}>Length</span>
          <select
            aria-label="Length"
            value={minutes}
            onChange={(event) =>
              onChange({ ...draft, end: draft.start + Number(event.target.value) * 60_000 })
            }
            className={fieldClass}
          >
            {[...new Set([...LENGTHS, minutes])]
              .sort((a, b) => a - b)
              .map((each) => (
                <option key={each} value={each}>
                  {lengthLabel(each)}
                </option>
              ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className={labelClass}>Goes in</span>
          <select
            aria-label="Goes in"
            value={target}
            onChange={(event) => {
              const [nextAccount, calendarId] = event.target.value.split('\u0000') as [string, string];
              onChange({ ...draft, account: nextAccount, calendarId: calendarId || null });
            }}
            className={cn(fieldClass, 'min-w-0 flex-1')}
          >
            {targets.map(({ account: each, calendar }) => (
              <option key={`${each.id}/${calendar.id}`} value={`${each.id}\u0000${calendar.id}`}>
                {calendar.primary ? addressOf(each) : `${addressOf(each)} · ${calendar.name}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      {reason && (
        <p className={cn(card ? 'n-ac-why ml-0' : 'm-0 text-note text-muted')}>
          <AresText inline text={reason.text} sources={reason.sources} />
        </p>
      )}
      {other && (
        <div className="mt-1 flex flex-col gap-1" data-testid="other-times">
          {other === 'loading' ? (
            <p className="m-0 text-note text-faint">Looking for times…</p>
          ) : (
            <>
              {other.slots.length ? (
                <ul className="m-0 flex list-none flex-wrap gap-1 p-0" aria-label="Other times">
                  {other.slots.map((slot) => (
                    <li key={slot.start}>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          onChange({ ...draft, start: slot.start, end: slot.end });
                          setOther(null);
                        }}
                      >
                        {whenLabel(slot.start, timeZone)}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 text-note text-faint">No free time in the next two weeks.</p>
              )}
              {other.guests
                .filter((guest) => !guest.checked && guest.why)
                .map((guest) => (
                  <p key={guest.email} className="m-0 text-note text-faint">
                    {guest.email}: {guest.why}
                  </p>
                ))}
            </>
          )}
        </div>
      )}
      {bookingLink && outside.length > 0 && (
        <Button
          size="sm"
          variant="ghost"
          className="mt-1 self-start"
          onClick={() => void copyBookingLink(bookingLink)}
        >
          Send your booking link instead
        </Button>
      )}
      <div className={cn(card ? 'n-ac-actions n-ac-meeting' : 'mt-2 flex flex-wrap gap-1.5')}>
        <Action card={card} primary disabled={!draft.title.trim()} onClick={onCreate}>
          Create
        </Action>
        <Action card={card} onClick={() => void otherTimes()}>
          Other times
        </Action>
        <Action
          card={card}
          title={`Open it in ${editor.where}’s own editor, filled in`}
          onClick={() => {
            window.open(editor.url, '_blank', 'noopener,noreferrer');
            onHandedOff?.(editor.where);
          }}
        >
          Edit in {editor.where} <span aria-hidden="true">↗</span>
        </Action>
        {onDismiss && (
          <Action card={card} title="Ares won’t offer it again for this Block’s text" onClick={onDismiss}>
            Dismiss
          </Action>
        )}
      </div>
    </div>
  );
}
