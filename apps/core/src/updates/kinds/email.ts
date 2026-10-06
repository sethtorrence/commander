// Update lines about Ares's sorting of email (#141): a Bucket Rule he suggests, and a Bucket he
// suggests the User adds. Each says what he noticed, what would change, and that nothing does until
// the User says.
import { bucketRuleSuggestionText } from '@commander/domain';
import type { LineKind } from './types';
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
