import { toast } from '@commander/ui';
import { useState } from 'react';
import type { ItemStoreClient } from '../../item-store/client';
import { MeetingCard } from '../calendar/MeetingCard';
import type { MeetingDraft, MeetingProposal } from '../calendar/meetings';
import type { Scheduling } from '../calendar/use-scheduling';

/*
  Ares's proposed meeting (#132) as a margin card beside its Block, among his other margin cards: the
  meeting card itself, with Create (accepting his suggestion with whatever the User changed on it),
  Other times, Edit in Google Calendar / Outlook, and Dismiss (he won't offer it again for this Block's
  text). Handing it to the provider's editor puts the suggestion away too, so it can't be made twice.
*/

const markBlock = (day: string, blockId: string, on: boolean) => {
  const block = document.querySelector<HTMLElement>(`#day-${day} [data-block="${blockId}"]`);
  if (on) block?.setAttribute('data-ares-mark', '');
  else block?.removeAttribute('data-ares-mark');
};

export function MeetingMarginCard({
  day,
  proposal,
  scheduling,
  itemStore,
  onCreate,
  onDismiss,
}: {
  day: string;
  proposal: MeetingProposal;
  scheduling: Scheduling;
  itemStore: ItemStoreClient;
  onCreate(proposal: MeetingProposal, draft: MeetingDraft): void;
  onDismiss(id: number): void;
}) {
  const [draft, setDraft] = useState(proposal.draft);
  const withGuests = draft.guests.length > 0 || draft.toFill.length > 0;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a card holding a form's worth of controls, not a fieldset
    <div
      className="n-ac"
      role="group"
      aria-label={`Event suggested by Ares: ${proposal.draft.title}`}
      data-ares-card=""
      data-block={proposal.blockId}
      data-testid="meeting-card"
      onMouseEnter={() => markBlock(day, proposal.blockId, true)}
      onMouseLeave={() => markBlock(day, proposal.blockId, false)}
    >
      <div className="n-ac-head">
        <span className="n-ac-tag">EV</span>
        <span>{withGuests ? 'Ares suggests a meeting' : 'Ares suggests holding time'}</span>
        <span className="n-ac-src">from this note</span>
      </div>
      <MeetingCard
        variant="margin"
        draft={draft}
        onChange={setDraft}
        timeZone={draft.timeZone}
        accounts={scheduling.accounts}
        calendars={scheduling.calendars}
        bookingLink={scheduling.bookingLink}
        itemStore={itemStore}
        reason={{ text: proposal.reason, sources: [proposal.source] }}
        details={proposal.source}
        onCreate={() => {
          markBlock(day, proposal.blockId, false);
          onCreate(proposal, draft);
        }}
        onHandedOff={(where) => {
          markBlock(day, proposal.blockId, false);
          onDismiss(proposal.id);
          toast(`Opened in ${where}: finish it there`);
        }}
        onDismiss={() => {
          markBlock(day, proposal.blockId, false);
          onDismiss(proposal.id);
        }}
      />
    </div>
  );
}
