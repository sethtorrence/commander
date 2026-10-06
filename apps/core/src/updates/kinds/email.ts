// Update lines about email: Ares's sorting (#141), a Bucket Rule he suggests and a Bucket he suggests
// the User adds, each saying what he noticed, what would change, and that nothing does until the User
// says; and a send-later time missed while Commander wasn't running (#139).
import { bucketRuleSuggestionText, missedSendText, sendLaterTime } from '@commander/domain';
import type { LineContext, LineKind } from './types';
import { cut, plural } from './words';

export const bucketRuleLines: LineKind<'bucket-rule-suggestion'> = {
  name: 'a Bucket Rule Ares suggests',
  template: ({ about }) =>
    `${bucketRuleSuggestionText(about)} A Bucket Rule would do it for you from now on: make the Rule, or dismiss this and I won’t ask again.`,
  facts: ({ about }) => [
    `What the User did: ${bucketRuleSuggestionText(about).split('. ')[0]}.`,
    `The Rule: ${bucketRuleSuggestionText(about).split('. ').slice(1).join('. ')}`,
    `How many emails the User sorted that way: ${plural(about.count, 'email')}`,
    'Accepting opens the Bucket Rule, filled in, for the User to save; dismissing stops Ares asking again.',
  ],
  row: () => null,
  guidance: `A Bucket Rule you suggest: say what the User kept doing with whose mail, the Rule that would do it for them, and that they can make it or dismiss it.
Good: "You’ve put 5 emails from stripe.com in Receipts. A Bucket Rule could do that for you: make it, or dismiss this and I won’t ask again."
Bad: "I noticed a pattern in your email." (Whose mail? What would happen?)`,
};

export const bucketSuggestionLines: LineKind<'bucket-suggestion'> = {
  name: 'a Bucket Ares suggests adding',
  template: ({ about }) =>
    `A Bucket you might want: “${about.name}”${about.description ? ` (${cut(about.description, 160)})` : ''}. ${about.reason ? `${cut(about.reason, 200).replace(/[.。]+$/, '')}. ` : ''}Nothing changes unless you add it; you can edit it first, or dismiss this.`,
  facts: ({ about }) => [
    `The Bucket Ares suggests: ${about.name}`,
    `Its description: ${about.description || '(none)'}`,
    'Ares never adds a Bucket himself: Add Bucket opens it, editable, for the User to save; dismissing stops it coming back.',
  ],
  row: () => null,
  // His own words (a name and a reason): kept as he wrote them, not worded again.
  apart: true,
  guidance:
    'A Bucket you suggest adding: say its name and what it is for, and that nothing changes unless the User adds it.',
};

// A Gmail message (or a personal Outlook one) whose send-later time passed while Commander was closed
// or the machine asleep (#139). Commander never sends it late by itself: the line asks, in Commander's
// own words (its time is exact and its recipients are the User's), with Send now, Edit and Discard.
export const missedSendLines: LineKind<'missed-send'> = {
  name: 'an email that missed its send-later time',
  template: ({ about }, context) => missedSendText(missedOf(about, context), context.now),
  facts: ({ about }, context) => [
    `When it was due: ${sendLaterTime(about.dueAt, context.now)}`,
    'What happened: Commander wasn’t running at that time (closed, or the machine asleep), so the email didn’t go, and Commander never sends late by itself.',
    'What to do: Send now, Edit or Discard. It waits in Scheduled until the User decides.',
  ],
  row: ({ about }, itemId, context) => {
    if (itemId !== about.itemId) return null;
    const item = context.item(itemId);
    if (item?.detail?.kind === 'email' && !item.detail.draft)
      return { state: 'Sent', actions: ['open'], settled: 'Sent' };
    return {
      state: `Was due ${sendLaterTime(about.dueAt, context.now)}`,
      actions: ['send-now', 'edit', 'discard'],
    };
  },
  apart: true,
  guidance:
    'An email that missed its send-later time: say who it was to and when it was due, and ask whether to send it now.',
};

function missedOf(about: { itemId: string; dueAt: number }, context: LineContext) {
  const item = context.item(about.itemId);
  const detail = item?.detail?.kind === 'email' ? item.detail : null;
  return {
    to: detail ? [...detail.to, ...detail.cc, ...detail.bcc] : [],
    subject: detail?.subject ?? item?.title ?? '',
    dueAt: about.dueAt,
  };
}
