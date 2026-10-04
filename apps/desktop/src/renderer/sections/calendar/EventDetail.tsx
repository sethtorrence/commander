import type { ActivityEntry, EventPerson } from '@commander/domain';
import { cn, Kbd } from '@commander/ui';
import { type ComponentType, type ReactNode, useRef } from 'react';
import { ItemWarning } from '../../links/ItemWarning';
import { ItemProject } from '../../projects/badges';
import { useProjects } from '../../projects/context';
import { describeIssueEntry } from '../linear/linear-issues';
import { Markdown } from '../linear/Markdown';
import { Eyebrow, PaneEmpty, PanePart } from '../todos/detail/parts';
import { TodoLinks } from '../todos/detail/TodoLinks';
import { whenShort } from '../todos/when';
import { type CalendarEvent, RESPONSE_NAMES, whenText } from './agenda';
import type { EventLink } from './calendar-events';
import { CalendarSwatch } from './EventRow';
import { clashText } from './marks';
import { eventZoneNote, hereAndThere } from './zones';

/*
  The detail pane beside the Agenda, after the Linear Section's: actions along the top (Edit in
  Google Calendar or Outlook, the meeting link, Project, Close), then the event's calendar and Account, title,
  when it is, its fields, attendees and their answers, description, Links and activity log. The
  description is the Source's text (untrusted), shown through the same safe rendering as Linear
  descriptions: plain text with links that open in the system browser, and no images.
*/

const none = <span className="font-medium text-faint">—</span>;

const personName = (person: EventPerson) => person.name ?? person.email;

const COMMANDER_KINDS = {
  'focus-block': 'Focus block',
  'busy-block': 'Busy block',
  meeting: 'Meeting',
} as const;

/** A link out of Commander, opened in the system browser through the window's new-window handler. */
function OutLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children}
    </a>
  );
}

function Fact({ field, label, children }: { field: string; label: string; children: ReactNode }) {
  return (
    <div
      data-field={field}
      className="flex items-center justify-between gap-2.5 border-b border-line2 py-[7px] font-mono text-label-lg leading-[1.3] font-medium uppercase tracking-tag"
    >
      <dt className="flex-none text-muted">{label}</dt>
      <dd className="m-0 min-w-0 text-right font-semibold [overflow-wrap:anywhere] text-ink">{children}</dd>
    </div>
  );
}

const action =
  'flex cursor-pointer items-center gap-[9px] border-0 border-r border-line2 bg-transparent px-3.5 font-mono text-label-lg leading-none font-semibold uppercase tracking-label whitespace-nowrap text-ink no-underline hover:bg-raise [&_kbd]:h-[18px] [&_kbd]:text-label';

export function EventDetail({
  event,
  editUrl,
  timeZone,
  secondTimeZone = null,
  clashes = [],
  links,
  history,
  onEdit,
  onFile,
  onClose,
  onOpenLink,
  Prep,
  invitation,
}: {
  event: CalendarEvent | null;
  /** Answering the event, when it is an invitation (#129). */
  invitation?: ReactNode;
  /** Where Edit opens the event (Google Calendar or Outlook on the web, as its Account); null without a link. */
  editUrl: string | null;
  timeZone: string;
  /** Settings → Calendar's second time zone, shown beside the time. */
  secondTimeZone?: string | null;
  /** The events of other Accounts it clashes with. */
  clashes?: readonly CalendarEvent[];
  links: EventLink[];
  history: ActivityEntry[];
  /** Edit was pressed (the Section refreshes the Account when the window comes back). */
  onEdit: (url: string) => void;
  onFile: () => void;
  onClose: () => void;
  onOpenLink: (link: EventLink) => void;
  /** The meeting's prep (#130), where the window has one to show. */
  Prep?: ComponentType<{ event: CalendarEvent }>;
}) {
  const { projects, archived } = useProjects();
  const pane = useRef<HTMLElement>(null);
  const detail = event?.detail;
  const zoneNote =
    detail && !detail.allDay
      ? eventZoneNote(
          { start: detail.start.at, end: detail.end.at, timeZone: detail.start.timeZone },
          timeZone,
        )
      : null;
  const people = detail?.attendees.filter((attendee) => !attendee.resource) ?? [];
  const rooms = detail?.attendees.filter((attendee) => attendee.resource) ?? [];
  return (
    <section
      ref={pane}
      tabIndex={-1}
      aria-label="Event detail"
      className="min-w-0 border-l border-line focus-visible:outline-none"
    >
      <div className="sticky top-(--body) max-h-[calc(100vh-var(--body))] overflow-auto [scrollbar-width:thin]">
        <div className="sticky top-0 z-2 flex h-11 items-stretch border-b border-line bg-sheet">
          {event && detail && (
            <>
              {editUrl && (
                <button
                  type="button"
                  onClick={() => onEdit(editUrl)}
                  className={cn(action, 'bg-ink text-sheet hover:bg-ink hover:opacity-90')}
                >
                  Edit in {event.source === 'outlook-calendar' ? 'Outlook' : 'Google Calendar'}{' '}
                  <span aria-hidden="true">↗</span>
                </button>
              )}
              {detail.meetingUrl && (
                <OutLink href={detail.meetingUrl} className={action}>
                  Join <span aria-hidden="true">↗</span>
                </OutLink>
              )}
              <button type="button" onClick={onFile} className={action}>
                <Kbd>B</Kbd>
                Project
              </button>
            </>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className={cn(action, 'border-r-0 border-l')}>
            <Kbd>Esc</Kbd>
            Close
          </button>
        </div>
        {event && detail ? (
          <div className="px-[22px] pt-[18px] pb-24">
            <Eyebrow className="flex items-center gap-2">
              <CalendarSwatch colour={detail.calendar.colour} />
              {detail.calendar.name}
              {detail.accountEmail &&
                detail.accountEmail !== detail.calendar.name &&
                ` · ${detail.accountEmail}`}
            </Eyebrow>
            <h2 className="mt-2 mb-1.5 font-sans text-[26px] leading-[1.15] font-bold tracking-[-0.015em] text-ink font-stretch-(--stretch-wide) [overflow-wrap:anywhere]">
              {event.title}
            </h2>
            <p
              className="m-0 font-sans text-[16px] leading-[1.3] font-light text-muted"
              data-testid="event-when"
            >
              {whenText(event, timeZone)}
            </p>
            {secondTimeZone && !detail.allDay && (
              <p
                className="m-0 mt-1 font-mono text-label-lg leading-[1.4] text-muted"
                data-testid="event-zones"
              >
                {hereAndThere(detail.start.at, timeZone, secondTimeZone)}
              </p>
            )}
            {zoneNote && (
              <p
                className="m-0 mt-1 font-mono text-label-lg leading-[1.4] text-muted"
                data-testid="event-zone-note"
              >
                {zoneNote}
              </p>
            )}
            <ItemWarning item={event} variant="pane" className="mt-3" />
            {clashes.map((other) => (
              <p
                key={other.id}
                role="note"
                data-testid="event-clash"
                className="m-0 mt-3 flex items-baseline gap-2 border border-signal bg-signal-soft px-2.5 py-1.5 text-note leading-[1.35] text-text"
              >
                <span
                  aria-hidden="true"
                  className="bg-signal px-1 font-mono text-[9px] font-bold uppercase text-on-signal"
                >
                  Clash
                </span>
                <span>{clashText(other)}</span>
              </p>
            ))}
            {invitation}
            {Prep && <Prep event={event} />}
            <dl className="mt-3.5 mb-0 border-t border-line">
              <Fact field="calendar" label="Calendar">
                {detail.calendar.name}
              </Fact>
              <Fact field="time-zone" label="Time zone">
                {detail.allDay ? 'All day' : (detail.start.timeZone ?? none)}
              </Fact>
              <Fact field="location" label="Location">
                {detail.location ?? none}
              </Fact>
              <Fact field="organiser" label="Organiser">
                {detail.organiser ? (detail.organiser.self ? 'You' : personName(detail.organiser)) : none}
              </Fact>
              <Fact field="response" label="Your answer">
                {detail.myResponse ? RESPONSE_NAMES[detail.myResponse] : none}
              </Fact>
              <Fact field="meeting" label="Meeting">
                {detail.meetingUrl ? (
                  <OutLink
                    href={detail.meetingUrl}
                    className="text-ink underline decoration-line underline-offset-2 hover:decoration-ink"
                  >
                    {detail.meetingUrl.replace(/^https?:\/\//, '')}
                  </OutLink>
                ) : (
                  none
                )}
              </Fact>
              <Fact field="busy" label="Show as">
                {detail.busy ? 'Busy' : 'Free'}
              </Fact>
              <Fact field="visibility" label="Visibility">
                {detail.private ? 'Private' : 'Default'}
              </Fact>
              <Fact field="series" label="Repeats">
                {detail.seriesId ? 'Part of a series' : 'One-off'}
              </Fact>
              {detail.createdByCommander && (
                <Fact field="commander" label="Made by">
                  Commander · {COMMANDER_KINDS[detail.createdByCommander]}
                </Fact>
              )}
              <Fact field="project" label="Project">
                <ItemProject item={event} />
              </Fact>
            </dl>

            <PanePart label="Guests" count={people.length}>
              {people.length ? (
                <ul className="m-0 list-none border border-line p-0" data-testid="event-guests">
                  {people.map((attendee) => (
                    <li
                      key={attendee.email}
                      className="flex justify-between gap-2.5 border-b border-line2 px-2.5 py-[7px] text-note leading-[18px] last:border-b-0"
                    >
                      <span className="min-w-0 truncate text-text" title={attendee.email}>
                        {attendee.self ? 'You' : personName(attendee)}
                        {attendee.organiser && <span className="text-muted"> · organiser</span>}
                        {attendee.optional && <span className="text-muted"> · optional</span>}
                      </span>
                      <span className="flex-none font-mono text-label-lg uppercase tracking-tag text-muted">
                        {RESPONSE_NAMES[attendee.response]}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <PaneEmpty>No guests.</PaneEmpty>
              )}
              {rooms.length > 0 && (
                <p className="m-0 mt-1.5 text-note text-muted">Rooms: {rooms.map(personName).join(', ')}</p>
              )}
            </PanePart>

            <section aria-label="Description" className="mt-[18px]">
              <Eyebrow className="mb-2">Description</Eyebrow>
              {detail.description?.trim() ? (
                <div className="border border-line px-3.5 py-3" data-testid="event-description">
                  <Markdown source={detail.description} />
                </div>
              ) : (
                <PaneEmpty>No description.</PaneEmpty>
              )}
            </section>

            <TodoLinks links={links} onOpen={onOpenLink} />

            <PanePart label="Activity" count={history.length}>
              <ol className="m-0 list-none border border-line p-0">
                {history.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex justify-between gap-2.5 border-b border-line2 px-2.5 py-[7px] text-note leading-[18px] last:border-b-0"
                  >
                    <span className="text-text">
                      {describeIssueEntry(entry, history, [...projects, ...archived])}
                    </span>
                    <time
                      dateTime={new Date(entry.at).toISOString()}
                      className="font-mono text-label-lg leading-[18px] whitespace-nowrap text-muted tabular-nums"
                    >
                      {whenShort(entry.at)}
                    </time>
                  </li>
                ))}
              </ol>
            </PanePart>
          </div>
        ) : (
          <p className="m-0 px-[22px] py-[18px] text-note text-faint">No event selected.</p>
        )}
      </div>
    </section>
  );
}
