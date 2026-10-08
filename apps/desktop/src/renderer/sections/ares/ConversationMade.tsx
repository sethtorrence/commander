import type { ConversationMade, ConversationTurn, Item } from '@commander/domain';
import { AresText, Button, cn } from '@commander/ui';
import { useMemo } from 'react';
import type { ItemStoreClient } from '../../item-store/client';
import { PrepBody, prepReadyLabel, useMeetingPreps } from '../../links/meeting-prep';
import { ARES_REPLY_FOCUS, handReply, SUGGESTED_REPLY_FOCUS } from '../../links/reply-handoff';
import { useUpdates } from '../../updates/context';
import { sectionFor } from '../todos/links';

/*
  What Ares's Skills made in one of his answers (#198), under his words, in the Ares Section and the
  Ares button's pop-up alike, styled as his suggestions are (dashed):

  - A draft reply (Draft) to an email thread or a Teams Chat, or a reply holding the User's booking link
    (Schedule): the text, drawn with AresText, and Open in composer, which opens the thread or Chat
    where it lives with the reply in the composer (the thread's suggested reply, opened as an ordinary
    Draft) or the Chat's reply box, for the User to edit and send. Nothing is sent from here.
  - A meeting's prep (Meeting prep): the prep as it stands now, read by its event, each line with the
    Items it rests on, and the event itself one click away.
*/

const heading = 'm-0 font-mono text-label leading-none font-semibold uppercase tracking-label text-muted';
const card = 'mt-2 px-3 py-2.5 outline-1 -outline-offset-1 outline-dashed outline-muted';

/** The cards for what one answer made, if it made anything. */
export function AnswerMade({
  turn,
  itemStore,
  onLeave,
}: {
  turn: Pick<ConversationTurn, 'made'>;
  // Where a meeting's prep is read; without it the prep card names the meeting only.
  itemStore?: ItemStoreClient;
  // Open in composer took the User elsewhere (the pop-up closes).
  onLeave?: () => void;
}) {
  // An Update line's actions (#236) are cards of their own (ConversationLine).
  const shown = (turn.made ?? []).filter((made): made is Shown => made.kind !== 'line-action');
  if (!shown.length) return null;
  return (
    <ul aria-label="What Ares made" className="m-0 list-none p-0">
      {shown.map((made, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: what an answer made never moves
        <li key={index}>
          {made.kind === 'meeting-prep' ? (
            <PrepCard made={made} itemStore={itemStore} />
          ) : (
            <ReplyCard made={made} onLeave={onLeave} />
          )}
        </li>
      ))}
    </ul>
  );
}

type Shown = Exclude<ConversationMade, { kind: 'line-action' }>;
type Reply = Exclude<Shown, { kind: 'meeting-prep' }>;

function ReplyCard({ made, onLeave }: { made: Reply; onLeave?: () => void }) {
  const { open } = useUpdates();
  const email = made.kind === 'email-draft' || (made.kind === 'booking-reply' && made.to === 'email');
  const text = made.kind === 'email-draft' ? made.body : made.text;
  const label = made.kind === 'booking-reply' ? 'Reply with your booking link' : 'Draft reply';

  const openIt = () => {
    if (made.kind === 'email-draft') {
      open({ kind: 'item', sectionId: 'email', itemId: made.itemId, focus: SUGGESTED_REPLY_FOCUS });
    } else {
      handReply(made.itemId, {
        text,
        ...(made.kind === 'booking-reply' && { link: made.link }),
      });
      open({
        kind: 'item',
        sectionId: email ? 'email' : 'teams',
        itemId: made.itemId,
        focus: ARES_REPLY_FOCUS,
      });
    }
    onLeave?.();
  };

  return (
    <section
      aria-label={`${label}: ${made.title}`}
      data-testid="conversation-draft"
      data-kind={made.kind}
      className={card}
    >
      <p className={cn(heading, 'flex min-w-0 items-center gap-1.5')}>
        <span className="flex-none">{label} · Ares</span>
        <span className="min-w-0 truncate font-sans text-note normal-case tracking-[0] text-text">
          {made.title}
        </span>
      </p>
      {made.kind === 'email-draft' && !made.sure && (
        <p className="m-0 mt-1.5 text-note text-muted" data-testid="conversation-draft-unsure">
          Ares isn’t sure about this one: read it closely before you send it.
        </p>
      )}
      <div
        className="mt-2 text-[14px] leading-[1.5] whitespace-pre-wrap text-ink [overflow-wrap:anywhere]"
        data-testid="conversation-draft-body"
      >
        {/* A booking link is the User's own, from Settings → Calendar: the only link it may follow. */}
        <AresText text={text} sources={made.kind === 'booking-reply' ? [made.link] : []} />
      </div>
      {made.kind === 'email-draft' && made.addedLinks.length > 0 && (
        <p className="m-0 mt-2 border-t border-line2 pt-2 text-note text-muted">
          Ares added {made.addedLinks.length === 1 ? 'a link' : 'links'} that{' '}
          {made.addedLinks.length === 1 ? 'is' : 'are'} in neither the thread nor your sent mail.{' '}
          {made.addedLinks.length === 1 ? 'It isn’t' : 'They aren’t'} sent unless you keep{' '}
          {made.addedLinks.length === 1 ? 'it' : 'them'} in the composer.
        </p>
      )}
      <div className="mt-2.5 flex items-center justify-end gap-2">
        <span className="mr-auto font-mono text-label uppercase tracking-label text-faint">
          Sent only when you press Send
        </span>
        <Button size="sm" variant="primary" onClick={openIt}>
          Open in composer
        </Button>
      </div>
    </section>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const clockOf = (at: number) => `${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}`;

function PrepCard({
  made,
  itemStore,
}: {
  made: Extract<ConversationMade, { kind: 'meeting-prep' }>;
  itemStore?: ItemStoreClient;
}) {
  const { open } = useUpdates();
  const eventIds = useMemo(() => [made.eventId], [made.eventId]);
  const preps = useMeetingPreps(itemStore ?? noItemStore, eventIds, { active: !!itemStore });
  const prep = preps.byEvent.get(made.eventId);
  const openEvent = () => open({ kind: 'item', sectionId: 'calendar', itemId: made.eventId });
  const openSource = (item: Item) => {
    const section = sectionFor(item.kind);
    if (section) open({ kind: 'item', sectionId: section, itemId: item.id });
  };
  return (
    <section aria-label={`Prep: ${made.title}`} data-testid="conversation-prep" className={card}>
      <div className="flex min-w-0 items-center gap-2">
        <p className={cn(heading, 'min-w-0 flex-1 truncate')}>
          Prep · {clockOf(made.startsAt)}
          {prep && <span className="ml-1.5 text-faint">{prepReadyLabel(prep)}</span>}
        </p>
        <Button size="sm" variant="ghost" onClick={openEvent} aria-label={`Open the event ${made.title}`}>
          {made.title}
        </Button>
      </div>
      {prep ? (
        <PrepBody prep={prep} sources={preps.sources} onOpenSource={openSource} className="mt-1.5" />
      ) : (
        <p className="m-0 mt-1.5 text-note text-muted">Reading the prep…</p>
      )}
    </section>
  );
}

// No Item store (a component test): nothing is read.
const noItemStore = (() => Promise.resolve([])) as unknown as ItemStoreClient;
